// Gives the editor window its own identity on the Windows taskbar (own button, own icon), so that
// "Pin to taskbar" pins Mark's Render PDF Editor instead of Microsoft Edge.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Taskbar
{
    public const string AppId = "MarksRender.PDFEditor";

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; public PropertyKey(Guid g, uint p) { fmtid = g; pid = p; } }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint c);
        [PreserveSig] int GetAt(uint i, out PropertyKey k);
        [PreserveSig] int GetValue(ref PropertyKey k, out PropVariant v);
        [PreserveSig] int SetValue(ref PropertyKey k, ref PropVariant v);
        [PreserveSig] int Commit();
    }

    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

    static readonly Guid AumFmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    static void SetString(IPropertyStore ps, uint pid, string value)
    {
        var key = new PropertyKey(AumFmt, pid);
        var v = new PropVariant { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(value) };
        ps.SetValue(ref key, ref v);
        PropVariantClear(ref v);
    }

    static void Tag(IntPtr hwnd, string exe, string name)
    {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore ps;
        if (SHGetPropertyStoreForWindow(hwnd, ref iid, out ps) != 0 || ps == null) return;
        SetString(ps, 2, "\"" + exe + "\"");   // RelaunchCommand – what a pinned button starts
        SetString(ps, 3, exe + ",0");          // RelaunchIconResource – icon of the pinned button
        SetString(ps, 4, name);                // RelaunchDisplayNameResource
        SetString(ps, 5, AppId);               // AppUserModelID – own taskbar group (set last)
        ps.Commit();
        Marshal.ReleaseComObject(ps);
    }

    // Watch for editor windows for a while and tag each one (new windows get tagged as they appear).
    public static void TagEditorWindows(string exe, string name, int seconds)
    {
        var done = new System.Collections.Generic.HashSet<IntPtr>();
        DateTime until = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < until)
        {
            EnumWindows((h, l) =>
            {
                if (done.Contains(h) || !IsWindowVisible(h)) return true;
                var cls = new StringBuilder(64); GetClassName(h, cls, 64);
                if (cls.ToString() != "Chrome_WidgetWin_1") return true;
                var title = new StringBuilder(512); GetWindowText(h, title, 512);
                if (title.ToString().EndsWith(name)) { try { Tag(h, exe, name); } catch { } done.Add(h); }
                return true;
            }, IntPtr.Zero);
            Thread.Sleep(500);
        }
    }
}
