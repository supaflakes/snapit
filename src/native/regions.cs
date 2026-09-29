// Assistant « zones » de Snapit : décrit les fenêtres visibles et, à la demande, les éléments d'interface
// sous la souris (UI Automation), pour que la sélection de zone les détecte comme dans Snagit.
// Il ne lit que la position et le type des fenêtres et des éléments : ni titre, ni texte, ni contenu.
//
// Protocole (une ligne par message ; coordonnées en pixels physiques de l'écran virtuel) :
//   entrée : "windows <id>"             fenêtres visibles, de la plus haute à la plus basse, et leurs sous-fenêtres
//            "at <id> <hwnd> <x> <y>"   éléments d'interface de la fenêtre sous le point, du plus grand au plus petit
//   sortie : "ready" au démarrage, puis une ligne JSON par demande :
//            {"id":1,"windows":[{"hwnd":…,"frame":[x,y,l,h],"client":[x,y,l,h],"children":[[x,y,l,h,parent],…]},…]}
//            {"id":2,"chain":[[x,y,l,h,"Type"],…]}
//   « parent » : indice de la sous-fenêtre parente dans la liste, -1 pour la fenêtre elle-même.
// Une recherche d'éléments en attente est remplacée par la suivante : seule la dernière position compte.
// L'assistant se ferme dès que Snapit ferme son entrée standard.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

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
    // vides) et les enveloppes de même taille sont traversés.
    static string Chain(IntPtr hwnd, int x, int y)
    {
        var clock = Stopwatch.StartNew();
        var point = new Point(x, y);
        var cache = new CacheRequest();
        cache.Add(AutomationElement.BoundingRectangleProperty);
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.IsOffscreenProperty);
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
                        if (!r.IsEmpty && (n.Area < bestArea || (n.Area == bestArea && n.Depth > best.Depth)))
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
        var json = new StringBuilder();
        Rect visible = Rect.Empty;
        foreach (Node n in chain)
        {
            // partie visible : un élément ne dépasse pas de ses ancêtres (page défilée plus haute que la fenêtre…)
            Rect r = visible.IsEmpty ? n.Rect : Rect.Intersect(visible, n.Rect);
            if (r.IsEmpty) break;
            if (r != visible) AppendElement(json, n.Element, r); // enveloppes identiques : une seule fois
            visible = r;
        }
        return json.ToString();
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

    static void AppendElement(StringBuilder json, AutomationElement element, Rect r)
    {
        if (r.Width < 1 || r.Height < 1) return;
        string type = element.Cached.ControlType.ProgrammaticName; // « ControlType.Button »
        if (json.Length > 0) json.Append(',');
        json.Append('[').Append((int)Math.Round(r.X)).Append(',').Append((int)Math.Round(r.Y)).Append(',')
            .Append((int)Math.Round(r.Width)).Append(',').Append((int)Math.Round(r.Height))
            .Append(",\"").Append(type.Substring(type.LastIndexOf('.') + 1)).Append("\"]");
    }
}
