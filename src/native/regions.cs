// Assistant « zones » de Snapit : décrit les fenêtres visibles et, à la demande, les éléments d'interface
// sous la souris (UI Automation), pour que la sélection de zone les détecte comme dans Snagit. Il réalise aussi
// la capture défilante d'une page web (ou de toute zone qui défile) : il la fait défiler de haut en bas en
// capturant l'écran, puis assemble les captures en une seule image.
// Des fenêtres et des éléments, il ne lit que la position, le type et la possibilité de défiler : ni titre, ni texte.
//
// Protocole (une ligne par message ; coordonnées en pixels physiques de l'écran virtuel) :
//   entrée : "windows <id>"             fenêtres visibles, de la plus haute à la plus basse, et leurs sous-fenêtres
//            "at <id> <hwnd> <x> <y>"   éléments d'interface de la fenêtre sous le point, du plus grand au plus petit
//            "scroll <id> <n> <échelle> <x> <y> <l> <h> <fichier>"
//                                       capture défilante de l'élément n (voir « chain »), visible dans la zone
//                                       [x, y, l, h] d'un écran à cette échelle ; l'image PNG va dans le fichier
//            "stop"                     arrête la capture défilante en cours : ce qui est déjà capturé est gardé
//   sortie : "ready" au démarrage, puis une ligne JSON par demande :
//            {"id":1,"windows":[{"hwnd":…,"frame":[x,y,l,h],"client":[x,y,l,h],"children":[[x,y,l,h,parent],…]},…]}
//            {"id":2,"chain":[[x,y,l,h,"Type",n],…]}
//            {"id":3,"progress":0.42}…  puis  {"id":3,"done":{"width":…,"height":…,"end":"bottom"}}  ou  {"id":3,"error":"…"}
//   « end » : "bottom" (bas de la page atteint), "stopped" (arrêtée), "limit" (image trop haute), "interrupted".
//   « parent » : indice de la sous-fenêtre parente dans la liste, -1 pour la fenêtre elle-même.
//   n : numéro de l'élément s'il défile verticalement, pour la capture défilante (0 sinon).
// Une recherche d'éléments en attente est remplacée par la suivante : seule la dernière position compte.
// L'assistant se ferme dès que Snapit ferme son entrée standard.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using Drawing = System.Drawing;
using ImageFormat = System.Drawing.Imaging.ImageFormat;
using ImageLockMode = System.Drawing.Imaging.ImageLockMode;
using PixelFormat = System.Drawing.Imaging.PixelFormat;

static class Regions
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc fn, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr parent, EnumProc fn, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")]
    static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")]
    static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")]
    static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT point, uint flags);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")]
    static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000;
    const uint LWA_ALPHA = 0x2;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
    const uint GA_PARENT = 1;
    const uint CWP_SKIPINVISIBLE = 0x1, CWP_SKIPTRANSPARENT = 0x4;
    const int MIN_SIZE = 8; // pixels : en dessous, ce n'est pas une zone utile
    const int MAX_CHILDREN = 300; // sous-fenêtres décrites par fenêtre
    const int PROBE_BUDGET = 250; // ms par recherche d'éléments : au-delà, on s'arrête là où on en est

    static readonly object output = new object();
    static readonly object gate = new object();
    static string[] pending; // dernière recherche d'éléments demandée

    static int Main()
    {
        // pixels physiques sur tous les écrans, quelle que soit leur mise à l'échelle
        try
        {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); // -4 : PER_MONITOR_AWARE_V2
        }
        catch (EntryPointNotFoundException)
        {
            SetProcessDPIAware();
        }

        var worker = new Thread(Probes) { IsBackground = true };
        worker.Start();
        Send("ready");

        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                var parts = line.Split(' ');
                if (parts[0] == "windows" && parts.Length == 2)
                {
                    ForgetScrollables(); // nouvelle sélection de zone
                    Send(ListWindows(parts[1]));
                }
                else if (parts[0] == "at" && parts.Length == 5)
                {
                    lock (gate)
                    {
                        pending = parts;
                        Monitor.Pulse(gate);
                    }
                }
                else if (parts[0] == "scroll" && parts.Length >= 9)
                {
                    StartScroll(line.Split(new[] { ' ' }, 9)); // le chemin du fichier peut contenir des espaces
                }
                else if (parts[0] == "stop")
                {
                    stopScroll = true;
                }
            }
        }
        catch { }
        return 0; // Snapit est fermé
    }

    static void Send(string text)
    {
        lock (output) { Console.Out.WriteLine(text); Console.Out.Flush(); }
    }

    // ------------------------------------------------------------------ fenêtres

    static string ListWindows(string id)
    {
        var json = new StringBuilder();
        json.Append("{\"id\":").Append(id).Append(",\"windows\":[");
        bool first = true;
        EnumWindows((hwnd, _) =>
        {
            RECT frame;
            if (!IsCandidate(hwnd, out frame)) return true;
            if (!first) json.Append(',');
            first = false;
            json.Append("{\"hwnd\":").Append(hwnd.ToInt64()).Append(",\"frame\":");
            AppendRect(json, frame);
            RECT client;
            if (ClientRect(hwnd, out client))
            {
                json.Append(",\"client\":");
                AppendRect(json, client);
            }
            json.Append(",\"children\":[");
            AppendChildren(json, hwnd, frame);
            json.Append("]}");
            return true;
        }, IntPtr.Zero);
        return json.Append("]}").ToString();
    }

    static bool IsCandidate(IntPtr hwnd, out RECT frame)
    {
        frame = new RECT();
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return false;
        int cloaked;
        // masquée par Windows : autre bureau virtuel, application suspendue…
        if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false;
        int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
        if ((ex & WS_EX_TRANSPARENT) != 0) return false; // surimpression qui laisse passer la souris
        if ((ex & WS_EX_LAYERED) != 0)
        {
            uint key, flags;
            byte alpha;
            if (GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags) && (flags & LWA_ALPHA) != 0 && alpha == 0) return false;
        }
        string cls = ClassName(hwnd);
        if (cls == "Progman" || cls == "WorkerW") return false; // le bureau : c'est l'écran entier
        // bords visibles, sans les bordures invisibles de redimensionnement ni l'ombre
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(hwnd, out frame)) return false;
        return frame.Right - frame.Left >= MIN_SIZE && frame.Bottom - frame.Top >= MIN_SIZE;
    }

    static bool ClientRect(IntPtr hwnd, out RECT rect)
    {
        if (!GetClientRect(hwnd, out rect)) return false;
        var origin = new POINT();
        if (!ClientToScreen(hwnd, ref origin)) return false;
        rect.Left += origin.X;
        rect.Right += origin.X;
        rect.Top += origin.Y;
        rect.Bottom += origin.Y;
        return rect.Right - rect.Left >= MIN_SIZE && rect.Bottom - rect.Top >= MIN_SIZE;
    }

    static void AppendChildren(StringBuilder json, IntPtr top, RECT frame)
    {
        var index = new Dictionary<IntPtr, int>();
        int count = 0;
        EnumChildWindows(top, (child, _) =>
        {
            if (count >= MAX_CHILDREN) return false;
            RECT r;
            if (!IsWindowVisible(child) || !GetWindowRect(child, out r)) return true;
            if ((GetWindowLong(child, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0) return true;
            // une sous-fenêtre peut déborder (contenu défilé) : on la limite à la fenêtre
            r.Left = Math.Max(r.Left, frame.Left);
            r.Top = Math.Max(r.Top, frame.Top);
            r.Right = Math.Min(r.Right, frame.Right);
            r.Bottom = Math.Min(r.Bottom, frame.Bottom);
            if (r.Right - r.Left < MIN_SIZE || r.Bottom - r.Top < MIN_SIZE) return true;
            // parent : le plus proche ancêtre décrit (les ancêtres sont énumérés avant leurs sous-fenêtres)
            int parent = -1;
            IntPtr a = GetAncestor(child, GA_PARENT);
            for (int depth = 0; depth < 64 && a != IntPtr.Zero && a != top; depth++, a = GetAncestor(a, GA_PARENT))
            {
                int i;
                if (index.TryGetValue(a, out i)) { parent = i; break; }
            }
            if (count > 0) json.Append(',');
            json.Append('[').Append(r.Left).Append(',').Append(r.Top).Append(',')
                .Append(r.Right - r.Left).Append(',').Append(r.Bottom - r.Top).Append(',').Append(parent).Append(']');
            index[child] = count++;
            return true;
        }, IntPtr.Zero);
    }

    static string ClassName(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }

    static void AppendRect(StringBuilder json, RECT r)
    {
        json.Append('[').Append(r.Left).Append(',').Append(r.Top).Append(',')
            .Append(r.Right - r.Left).Append(',').Append(r.Bottom - r.Top).Append(']');
    }

    // ------------------------------------------------------- éléments d'interface

    static void Probes()
    {
        for (;;)
        {
            string[] request;
            lock (gate)
            {
                while (pending == null) Monitor.Wait(gate);
                request = pending;
                pending = null;
            }
            string chain;
            try
            {
                chain = Chain(new IntPtr(long.Parse(request[2])), int.Parse(request[3]), int.Parse(request[4]));
            }
            catch
            {
                chain = ""; // fenêtre fermée, application qui ne répond pas…
            }
            Send("{\"id\":" + request[1] + ",\"chain\":[" + chain + "]}");
        }
    }

    sealed class Node
    {
        public AutomationElement Element;
        public Node Parent;
        public Rect Rect;
        public int Depth;
        public double Area { get { return Rect.IsEmpty ? 0 : Rect.Width * Rect.Height; } }
    }

    // Cherche dans l'arbre UI Automation, depuis la sous-fenêtre sous le point, le plus petit élément qui le
    // contient, puis renvoie ses ancêtres. Seules les branches qui contiennent le point sont explorées, en
    // commençant par les plus petites. Les conteneurs sans bords (Chrome range son interface dans des « Pane »
    // vides) et les enveloppes de même taille sont traversés. À taille presque égale, l'élément le plus profond
    // l'emporte : dans une fenêtre Electron, la page est plus grande d'un pixel qu'un panneau technique voisin.
    static string Chain(IntPtr hwnd, int x, int y)
    {
        var clock = Stopwatch.StartNew();
        var point = new Point(x, y);
        var cache = new CacheRequest();
        cache.Add(AutomationElement.BoundingRectangleProperty);
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.IsOffscreenProperty);
        // pour la capture défilante
        cache.Add(AutomationElement.RuntimeIdProperty);
        cache.Add(AutomationElement.IsScrollPatternAvailableProperty);
        cache.Add(ScrollPattern.VerticallyScrollableProperty);
        cache.Add(ScrollPattern.VerticalViewSizeProperty);
        Node best;
        using (cache.Activate())
        {
            var root = new Node { Element = AutomationElement.FromHandle(DeepestChild(hwnd, x, y)) };
            root.Rect = root.Element.Cached.BoundingRectangle;
            best = root;
            double bestArea = root.Rect.IsEmpty ? double.MaxValue : root.Area;
            var stack = new Stack<Node>();
            stack.Push(root);
            for (int visited = 0; stack.Count > 0 && visited < 300 && clock.ElapsedMilliseconds < PROBE_BUDGET; visited++)
            {
                Node node = stack.Pop();
                var inside = new List<Node>();
                try
                {
                    foreach (AutomationElement child in node.Element.FindAll(TreeScope.Children, Automation.ControlViewCondition))
                    {
                        Rect r = child.Cached.BoundingRectangle;
                        if (!r.IsEmpty && (!r.Contains(point) || child.Cached.IsOffscreen)) continue;
                        var n = new Node { Element = child, Parent = node, Rect = r, Depth = node.Depth + 1 };
                        if (!r.IsEmpty && (n.Area < bestArea * 0.99 || (n.Area <= bestArea * 1.01 && n.Depth > best.Depth)))
                        {
                            best = n;
                            bestArea = n.Area;
                        }
                        inside.Add(n);
                    }
                }
                catch
                {
                    continue; // élément disparu entre-temps
                }
                // le plus petit (ou sans bords) en dernier sur la pile : exploré en premier
                inside.Sort((a, b) => b.Area.CompareTo(a.Area));
                foreach (Node n in inside) stack.Push(n);
            }
        }
        // de la fenêtre à l'élément trouvé, sans les conteneurs sans bords
        var chain = new List<Node>();
        for (Node n = best; n != null; n = n.Parent) if (!n.Rect.IsEmpty) chain.Add(n);
        chain.Reverse();
        var found = new List<Found>();
        Rect visible = Rect.Empty;
        foreach (Node n in chain)
        {
            // partie visible : un élément ne dépasse pas de ses ancêtres (page défilée plus haute que la fenêtre…)
            Rect r = visible.IsEmpty ? n.Rect : Rect.Intersect(visible, n.Rect);
            if (r.IsEmpty) break;
            int scroll = ScrollNumber(n.Element);
            // enveloppes identiques : une seule fois, qui défile si l'une d'elles défile
            if (r != visible) found.Add(new Found { Rect = r, Element = n.Element, Scroll = scroll });
            else if (scroll > 0 && found.Count > 0 && found[found.Count - 1].Scroll == 0) found[found.Count - 1].Scroll = scroll;
            visible = r;
        }
        var json = new StringBuilder();
        foreach (Found f in found) AppendElement(json, f);
        return json.ToString();
    }

    sealed class Found
    {
        public Rect Rect;
        public AutomationElement Element;
        public int Scroll;
    }

    static IntPtr DeepestChild(IntPtr hwnd, int x, int y)
    {
        IntPtr current = hwnd;
        for (int i = 0; i < 32; i++)
        {
            var p = new POINT { X = x, Y = y };
            if (!ScreenToClient(current, ref p)) break;
            IntPtr child = ChildWindowFromPointEx(current, p, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
            if (child == IntPtr.Zero || child == current) break;
            current = child;
        }
        return current;
    }

    static void AppendElement(StringBuilder json, Found f)
    {
        Rect r = f.Rect;
        if (r.Width < 1 || r.Height < 1) return;
        string type = f.Element.Cached.ControlType.ProgrammaticName; // « ControlType.Button »
        if (json.Length > 0) json.Append(',');
        json.Append('[').Append((int)Math.Round(r.X)).Append(',').Append((int)Math.Round(r.Y)).Append(',')
            .Append((int)Math.Round(r.Width)).Append(',').Append((int)Math.Round(r.Height))
            .Append(",\"").Append(type.Substring(type.LastIndexOf('.') + 1)).Append("\",").Append(f.Scroll).Append(']');
    }

    // ------------------------------------------------------------ capture défilante

    // Éléments qui défilent trouvés par les recherches, numérotés à partir de 1 pour la sélection de zone en cours
    static readonly Dictionary<string, int> scrollNumbers = new Dictionary<string, int>();
    static readonly List<AutomationElement> scrollables = new List<AutomationElement>();
    static volatile bool stopScroll;
    static Thread scrolling;

    // Numéro de l'élément s'il défile verticalement (le même à chaque recherche), 0 sinon. Un contenu qui ne
    // dépasse que d'un pixel ne compte pas.
    static int ScrollNumber(AutomationElement element)
    {
        try
        {
            if (!Equals(element.GetCachedPropertyValue(AutomationElement.IsScrollPatternAvailableProperty), true)) return 0;
            if (!Equals(element.GetCachedPropertyValue(ScrollPattern.VerticallyScrollableProperty), true)) return 0;
            object view = element.GetCachedPropertyValue(ScrollPattern.VerticalViewSizeProperty);
            if (!(view is double) || (double)view >= 99) return 0;
            string key = string.Join(".", (int[])element.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty));
            lock (scrollables)
            {
                int n;
                if (!scrollNumbers.TryGetValue(key, out n))
                {
                    scrollables.Add(element);
                    scrollNumbers[key] = n = scrollables.Count;
                }
                return n;
            }
        }
        catch
        {
            return 0; // propriétés indisponibles : l'élément est proposé sans capture défilante
        }
    }

    static void ForgetScrollables()
    {
        lock (scrollables)
        {
            scrollNumbers.Clear();
            scrollables.Clear();
        }
    }

    // "scroll <id> <n> <échelle> <x> <y> <l> <h> <fichier>" : la capture tourne à part, « stop » peut l'arrêter.
    static void StartScroll(string[] p)
    {
        string id = p[1];
        try
        {
            AutomationElement element = null;
            int n = int.Parse(p[2]);
            lock (scrollables) if (n >= 1 && n <= scrollables.Count) element = scrollables[n - 1];
            double scale = double.Parse(p[3], CultureInfo.InvariantCulture);
            var area = new Drawing.Rectangle(int.Parse(p[4]), int.Parse(p[5]), int.Parse(p[6]), int.Parse(p[7]));
            if (element == null || area.Width < 16 || area.Height < 16 || (scrolling != null && scrolling.IsAlive))
            {
                Send("{\"id\":" + id + ",\"error\":\"unavailable\"}");
                return;
            }
            stopScroll = false;
            string file = p[8];
            scrolling = new Thread(() =>
            {
                string result;
                try
                {
                    result = new PageCapture(id, element, area, scale).Run(file);
                }
                catch (Exception e)
                {
                    result = "{\"id\":" + id + ",\"error\":\"" + e.GetType().Name + "\"}"; // page fermée, mémoire…
                }
                Send(result);
            }) { IsBackground = true };
            scrolling.Start();
        }
        catch (Exception)
        {
            Send("{\"id\":" + id + ",\"error\":\"format\"}"); // commande mal formée : l'assistant continue
        }
    }

    // Capture de l'écran dans la zone, et signature de chaque ligne (entière, et par bande verticale) pour la
    // comparer rapidement à une autre capture. Les bords, où se trouve la barre de défilement, sont ignorés.
    sealed class Frame
    {
        public readonly int[] Pixels;
        public readonly ulong[] Rows;
        public readonly ulong[][] Bands;

        public Frame(int[] pixels, int w, int h, int edge, int bands)
        {
            Pixels = pixels;
            Rows = new ulong[h];
            Bands = new ulong[bands][];
            for (int b = 0; b < bands; b++) Bands[b] = new ulong[h];
            int span = w - 2 * edge;
            for (int y = 0; y < h; y++)
            {
                int row = y * w;
                ulong whole = 14695981039346656037UL;
                for (int b = 0; b < bands; b++)
                {
                    ulong hash = 14695981039346656037UL; // FNV-1a
                    for (int x = edge + span * b / bands, end = edge + span * (b + 1) / bands; x < end; x++)
                        hash = (hash ^ (uint)pixels[row + x]) * 1099511628211UL;
                    Bands[b][y] = hash;
                    whole = (whole ^ hash) * 1099511628211UL;
                }
                Rows[y] = whole;
            }
        }
    }

    // Morceau de l'image finale : lignes [From, To) d'une capture
    struct Part
    {
        public int[] Pixels;
        public int From, To;
    }

    // Capture défilante : remonte en haut de l'élément, le fait défiler par pas en capturant la zone, superpose
    // chaque capture à la précédente (au pixel près, d'après le contenu) et n'en garde que la partie nouvelle.
    // Un en-tête ou un pied de page fixes (identiques d'une capture à l'autre) ne sont gardés qu'une fois, la
    // barre de défilement est retirée. L'élément revient ensuite à sa position de départ.
    sealed class PageCapture
    {
        const int MAX_HEIGHT = 30000; // pixels : au-delà, l'image serait trop lourde pour l'éditeur
        const long MAX_PIXELS = 80000000;
        const int TIME_BUDGET = 90000; // ms

        readonly string id;
        readonly AutomationElement element;
        readonly Drawing.Rectangle area;
        readonly int w, h;
        readonly int edge; // largeur des bords ignorés pour superposer les captures (barre de défilement)
        readonly int bands; // bandes verticales comparées séparément (une barre latérale fixe ne gêne pas les autres)
        readonly int margin; // bas de chaque capture laissé à la suivante (coins arrondis de la fenêtre…)
        readonly int overlap; // hauteur visée commune à deux captures successives
        readonly List<Part> parts = new List<Part>();
        readonly double viewport; // hauteur de l'élément : la page en montre VerticalViewSize %
        ScrollPattern pattern;

        public PageCapture(string id, AutomationElement element, Drawing.Rectangle zone, double scale)
        {
            this.id = id;
            this.element = element;
            // la zone montrée par Snapit, ramenée aux bords de l'élément (elle peut en déborder d'un pixel ou deux)
            Rect bounds = element.Current.BoundingRectangle;
            viewport = bounds.IsEmpty ? 0 : bounds.Height;
            area = zone;
            if (!bounds.IsEmpty)
            {
                var inside = Drawing.Rectangle.Intersect(zone, new Drawing.Rectangle((int)Math.Round(bounds.X), (int)Math.Round(bounds.Y), (int)Math.Round(bounds.Width), (int)Math.Round(bounds.Height)));
                if (inside.Width >= 16 && inside.Height >= 16) area = inside;
            }
            w = area.Width;
            h = area.Height;
            edge = Math.Min(w / 8, (int)Math.Ceiling(24 * scale));
            bands = Math.Max(1, Math.Min(6, (w - 2 * edge) / 96));
            margin = Math.Min(h / 10, (int)Math.Ceiling(12 * scale));
            overlap = Math.Max(h / 6, 32);
        }

        public string Run(string file)
        {
            pattern = (ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern);
            double original = pattern.Current.VerticalScrollPercent;
            var clock = Stopwatch.StartNew();
            int header = int.MaxValue; // en-tête fixe : lignes identiques en haut de toutes les captures
            int cut = margin; // bas de la dernière capture laissé à la suivante
            int left = 0, right = 0; // colonnes retirées : barre de défilement
            int end = -1; // position dans la page de la fin de l'image assemblée (-1 : rien encore)
            int offset = 0; // position dans la page du haut de la capture `a`
            double pct = 0, measured = 0;
            // fin de la capture : "bottom" (bas de la page), "stopped" (Échap), "limit" (image trop haute) ou
            // "interrupted" (captures impossibles à superposer, délai dépassé)
            string outcome = "bottom";
            try
            {
                Frame a = Grab();
                if (original > 0)
                {
                    pattern.SetScrollPercent(ScrollPattern.NoScroll, 0);
                    a = Settle(a) ?? a;
                }
                int limit = (int)Math.Min(MAX_HEIGHT, MAX_PIXELS / w);
                while (pct < 100)
                {
                    if (stopScroll)
                    {
                        outcome = "stopped";
                        break;
                    }
                    if (clock.ElapsedMilliseconds > TIME_BUDGET)
                    {
                        outcome = "interrupted";
                        break;
                    }
                    // pas visé : la hauteur utile de la capture, moins de quoi superposer les deux captures
                    int usable = h - (header == int.MaxValue ? 0 : header) - cut;
                    int wanted = end < 0 ? h * 3 / 5 : Math.Max(usable - overlap, Math.Max(usable / 3, 16));
                    double rate = Math.Max(measured, PixelsPerPercent());
                    if (rate <= 0) break; // l'élément ne défile plus
                    Frame b = null;
                    int top = 0, bottom = 0, d = -1;
                    double next = pct;
                    // défilement trop grand (la page s'est allongée…) : on recommence avec un pas plus petit
                    for (int attempt = 0; attempt < 4 && d < 0 && !stopScroll; attempt++, wanted /= 2)
                    {
                        next = Math.Min(100, pct + wanted / rate);
                        pattern.SetScrollPercent(ScrollPattern.NoScroll, next);
                        b = Settle(a);
                        if (b == null) break; // arrêt demandé
                        d = Shift(a, b, (int)Math.Round((next - pct) * rate), out top, out bottom);
                    }
                    if (b == null)
                    {
                        outcome = "stopped";
                        break;
                    }
                    if (d < 0)
                    {
                        outcome = "interrupted";
                        break;
                    }
                    if (d == 0)
                    {
                        if (end < 0) outcome = "interrupted"; // la page n'a pas défilé du tout
                        break; // sinon, le bas est atteint
                    }

                    int bottomCut = Math.Max(bottom, margin);
                    if (end < 0)
                    {
                        Add(a, 0, h - bottomCut); // première capture, en-tête compris
                        end = h - bottomCut;
                    }
                    header = Math.Min(header, top);
                    left = Math.Max(left, EdgeCut(a, b, d, top, bottom, true));
                    right = Math.Max(right, EdgeCut(a, b, d, top, bottom, false));
                    offset += d;
                    int from = Math.Max(end - offset, header);
                    if (from < h - bottomCut)
                    {
                        Add(b, from, h - bottomCut);
                        end = offset + h - bottomCut;
                    }
                    cut = bottomCut;
                    if (next < 100) measured = d / (next - pct);
                    pct = next;
                    a = b;
                    Progress((offset + h) / (offset + h + (100 - pct) * rate));
                    if (Height() >= limit)
                    {
                        outcome = "limit";
                        break;
                    }
                }
                // dernière capture : jusqu'en bas, pied de page compris
                int rest = end < 0 ? 0 : Math.Max(end - offset, 0);
                if (rest < h) Add(a, rest, h);
                int height = Math.Min(Height(), limit);
                if (Height() > limit) outcome = "limit";
                Progress(1); // l'encodage d'une très grande image prend quelques secondes
                Save(file, height, left, right);
                return "{\"id\":" + id + ",\"done\":{\"width\":" + (w - left - right) + ",\"height\":" + height + ",\"end\":\"" + outcome + "\"}}";
            }
            finally
            {
                try
                {
                    if (original >= 0) pattern.SetScrollPercent(ScrollPattern.NoScroll, original); // retour à la position de départ
                }
                catch { }
            }
        }

        void Progress(double value)
        {
            Send("{\"id\":" + id + ",\"progress\":" + value.ToString("0.###", CultureInfo.InvariantCulture) + "}");
        }

        // Hauteur de page parcourue par point de pourcentage de défilement, d'après UI Automation.
        double PixelsPerPercent()
        {
            double view = pattern.Current.VerticalViewSize;
            return view > 0 && view < 100 ? viewport * (100 / view - 1) / 100 : 0;
        }

        int Height()
        {
            int total = 0;
            foreach (Part part in parts) total += part.To - part.From;
            return total;
        }

        void Add(Frame f, int from, int to)
        {
            if (to > from) parts.Add(new Part { Pixels = f.Pixels, From = from, To = to });
        }

        Frame Grab()
        {
            var pixels = new int[w * h];
            using (var bitmap = new Drawing.Bitmap(w, h, PixelFormat.Format32bppRgb))
            {
                using (var g = Drawing.Graphics.FromImage(bitmap))
                    g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, Drawing.CopyPixelOperation.SourceCopy);
                var data = bitmap.LockBits(new Drawing.Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
                try
                {
                    Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                }
                finally
                {
                    bitmap.UnlockBits(data);
                }
            }
            for (int i = 0; i < pixels.Length; i++) pixels[i] |= unchecked((int)0xFF000000); // opaque
            return new Frame(pixels, w, h, edge, bands);
        }

        // Attend que la zone ait défilé (capture différente de `before`) puis soit stable. null : arrêt demandé.
        Frame Settle(Frame before)
        {
            var clock = Stopwatch.StartNew();
            Thread.Sleep(50);
            Frame last = Grab();
            bool moved = DifferentRows(last, before) > 0;
            for (;;)
            {
                if (stopScroll) return null;
                Thread.Sleep(30);
                Frame next = Grab();
                bool stable = DifferentRows(next, last) <= h / 100;
                moved = moved || DifferentRows(next, before) > 0;
                last = next;
                long t = clock.ElapsedMilliseconds;
                if (moved ? stable : t > 700) return last; // stable, ou rien n'a bougé
                if (t > 1500) return last; // contenu animé : la capture est prise telle quelle
            }
        }

        int DifferentRows(Frame a, Frame b)
        {
            int n = 0;
            for (int y = 0; y < h; y++) if (a.Rows[y] != b.Rows[y]) n++;
            return n;
        }

        // Superpose b à a : décalage d tel que la ligne y de b montre ce que montrait la ligne y + d de a.
        // Les lignes identiques en haut et en bas des deux captures sont fixes (en-tête, pied de page).
        // 0 : rien n'a défilé ; -1 : aucun décalage convaincant.
        int Shift(Frame a, Frame b, int expected, out int top, out int bottom)
        {
            top = 0;
            while (top < h && a.Rows[top] == b.Rows[top]) top++;
            bottom = 0;
            while (bottom < h - top && a.Rows[h - 1 - bottom] == b.Rows[h - 1 - bottom]) bottom++;
            if (h - top - bottom < 4) return 0;
            int max = h - top - bottom - Math.Max(8, overlap / 3); // assez de lignes communes pour conclure
            if (max < 1) return -1;

            // lignes parlantes : rares dans leur bande (une ligne blanche ressemble à toutes les autres)
            var rare = new bool[bands][];
            for (int k = 0; k < bands; k++)
            {
                var count = new Dictionary<ulong, int>();
                ulong[] s = a.Bands[k];
                for (int y = top; y < h - bottom; y++)
                {
                    int c;
                    count.TryGetValue(s[y], out c);
                    count[s[y]] = c + 1;
                }
                rare[k] = new bool[h];
                for (int y = top; y < h - bottom; y++) rare[k][y] = count[s[y]] <= 2;
            }

            // chaque bande vote : lignes parlantes retrouvées, moins les lignes différentes. Une bande qui ne suit
            // pas le défilement (barre latérale fixe, animation) ne compte pas.
            int best = -1;
            double bestScore = 0;
            for (int d = 1; d <= max; d++)
            {
                double score = 0;
                for (int k = 0; k < bands; k++)
                {
                    ulong[] sa = a.Bands[k], sb = b.Bands[k];
                    bool[] r = rare[k];
                    int found = 0, missed = 0;
                    for (int y = top, stop = h - bottom - d; y < stop; y++)
                    {
                        if (sb[y] != sa[y + d]) missed++;
                        else if (r[y + d]) found++;
                    }
                    score += Math.Max(0, found - 3 * missed);
                }
                score -= Math.Abs(d - expected) * 1e-6; // à égalité, le défilement demandé
                if (score > bestScore)
                {
                    bestScore = score;
                    best = d;
                }
            }
            if (bestScore >= 3.5) return best; // quelques lignes parlantes retrouvées suffisent
            // peu de lignes parlantes (zones unies) : le défilement demandé, si la plupart des bandes le confirment
            if (expected < 1 || expected > max) return -1;
            int rows = h - bottom - expected - top, agree = 0;
            for (int k = 0; k < bands; k++)
            {
                int same = 0;
                for (int y = top; y < top + rows; y++) if (b.Bands[k][y] == a.Bands[k][y + expected]) same++;
                if (same >= rows * 0.95) agree++;
            }
            return agree * 2 > bands ? expected : -1;
        }

        // Colonnes d'un bord qui ne suivent pas le défilement (le curseur de la barre de défilement se déplace) :
        // leur nombre, compté depuis le bord.
        int EdgeCut(Frame a, Frame b, int d, int top, int bottom, bool leftSide)
        {
            int rows = h - bottom - d - top;
            if (rows <= 0) return 0;
            for (int i = edge - 1; i >= 0; i--) // de l'intérieur vers le bord
            {
                int x = leftSide ? i : w - 1 - i;
                int missed = 0;
                for (int y = top; y < top + rows; y++) if (b.Pixels[y * w + x] != a.Pixels[(y + d) * w + x]) missed++;
                if (missed > Math.Max(1, rows / 200)) return i + 1;
            }
            return 0;
        }

        void Save(string file, int height, int left, int right)
        {
            int width = w - left - right;
            // PNG sans canal alpha ; GDI+ convertit les pixels à la fin de l'écriture
            using (var bitmap = new Drawing.Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                var data = bitmap.LockBits(new Drawing.Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                try
                {
                    int y = 0;
                    foreach (Part part in parts)
                        for (int row = part.From; row < part.To && y < height; row++, y++)
                            Marshal.Copy(part.Pixels, row * w + left, data.Scan0 + y * data.Stride, width);
                }
                finally
                {
                    bitmap.UnlockBits(data);
                }
                bitmap.Save(file, ImageFormat.Png);
            }
        }
    }
}
