// Assistant clavier de Snapit : intercepte les raccourcis de capture (notamment Impr. écran)
// avant l'Outil Capture de Windows, grâce à un hook clavier bas niveau.
// Il n'enregistre ni ne transmet aucune autre frappe : seules les combinaisons demandées
// par Snapit sont reconnues, bloquées et signalées sur la sortie standard.
//
// Protocole (une ligne par message) :
//   entrée  : "set id:mods:vk id:mods:vk ..."  remplace les combinaisons surveillées
//             mods = 1 Ctrl | 2 Alt | 4 Maj | 8 Windows ; vk = code de touche virtuelle
//   sortie  : "ready" au démarrage, puis l'id de chaque combinaison déclenchée
// L'assistant se ferme dès que Snapit ferme son entrée standard.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

static class KeyHook
{
    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vk);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(string name);

    static readonly HookProc Proc = OnKey; // référence conservée : le ramasse-miettes ne doit pas la libérer
    static IntPtr hook;
    static volatile KeyValuePair<string, int[]>[] combos = new KeyValuePair<string, int[]>[0];
    static readonly HashSet<uint> swallowUp = new HashSet<uint>();
    static readonly object output = new object();

    static int Main()
    {
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, Proc, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) { Send("error"); return 1; }

        var reader = new Thread(ReadCommands) { IsBackground = true };
        reader.Start();
        Send("ready");

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        return 0;
    }

    static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (!line.StartsWith("set")) continue;
                var list = new List<KeyValuePair<string, int[]>>();
                foreach (var item in line.Substring(3).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var p = item.Split(':');
                    if (p.Length != 3) continue;
                    list.Add(new KeyValuePair<string, int[]>(p[0], new[] { int.Parse(p[1]), int.Parse(p[2]) }));
                }
                combos = list.ToArray();
            }
        }
        catch { }
        Environment.Exit(0); // Snapit est fermé
    }

    static void Send(string text)
    {
        lock (output) { Console.Out.WriteLine(text); Console.Out.Flush(); }
    }

    static bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            uint vk = (uint)Marshal.ReadInt32(lParam);
            if ((message == WM_KEYUP || message == WM_SYSKEYUP) && swallowUp.Remove(vk)) return (IntPtr)1;
            if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
            {
                int mods = (IsDown(0x11) ? 1 : 0) | (IsDown(0x12) ? 2 : 0) | (IsDown(0x10) ? 4 : 0) | (IsDown(0x5B) || IsDown(0x5C) ? 8 : 0);
                foreach (var combo in combos)
                {
                    if (combo.Value[1] == vk && combo.Value[0] == mods)
                    {
                        swallowUp.Add(vk);
                        Send(combo.Key);
                        return (IntPtr)1; // la touche n'atteint ni Windows ni l'Outil Capture
                    }
                }
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }
}
