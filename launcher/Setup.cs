// Mark's Render PDF Editor – built-in installer / uninstaller (per-user, no admin rights needed).
// Runs when the exe is named "...Setup.exe" (or started with --install); uninstall via Settings → Apps.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup
{
    const string Name = "Mark's Render PDF Editor";
    const string Key = "MarksRenderPDFEditor";
    const string ProgId = "MarksRenderPDF.pdf";

    static string InstallDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); } }
    static string InstalledExe { get { return Path.Combine(InstallDir, Name + ".exe"); } }
    static string StartMenuLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk"); } }
    static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name + ".lnk"); } }

    [DllImport("shell32.dll")] static extern void SHChangeNotify(int eventId, int flags, IntPtr a, IntPtr b);

    // returns true when the app should start afterwards
    public static bool Quiet; // --quiet: no questions, no pop-ups (for IT / scripted installs)

    static DialogResult Ask(string text, MessageBoxButtons b, MessageBoxIcon i, DialogResult quietAnswer)
    { return Quiet ? quietAnswer : MessageBox.Show(text, Name, b, i); }

    public static bool Install()
    {
        string self = Application.ExecutablePath;
        bool already = File.Exists(InstalledExe);
        var answer = Ask(
            (already ? "Update " : "Install ") + Name + " " + AppInfo.Version + " on this computer?\n\n" +
            "• Adds it to the Start menu and the desktop\n" +
            "• Adds it to \"Open with\" for PDF files (your default PDF app is not changed)\n" +
            "• No administrator rights needed – remove it any time in Settings → Apps",
            MessageBoxButtons.OKCancel, MessageBoxIcon.Information, DialogResult.OK);
        if (answer != DialogResult.OK) return false;
        try
        {
            Directory.CreateDirectory(InstallDir);
            if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase))
                File.Copy(self, InstalledExe, true);

            Shortcut(StartMenuLink); Shortcut(DesktopLink);

            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + ProgId))
            {
                k.SetValue("", "PDF document");
                using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", "\"" + InstalledExe + "\",0");
                using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", "\"" + InstalledExe + "\" \"%1\"");
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.pdf\OpenWithProgids")) k.SetValue(ProgId, new byte[0], RegistryValueKind.None);
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\" + Name + @".exe\SupportedTypes")) k.SetValue(".pdf", "");

            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Key))
            {
                k.SetValue("DisplayName", Name);
                k.SetValue("DisplayVersion", AppInfo.Version);
                k.SetValue("Publisher", "Mark's Render");
                k.SetValue("DisplayIcon", "\"" + InstalledExe + "\",0");
                k.SetValue("InstallLocation", InstallDir);
                k.SetValue("UninstallString", "\"" + InstalledExe + "\" --uninstall");
                k.SetValue("URLInfoAbout", "https://github.com/sttechnllc/render_pdf");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)(new FileInfo(InstalledExe).Length / 1024), RegistryValueKind.DWord);
            }
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // refresh file-type icons / Open with
            if (Quiet) return false;
            MessageBox.Show(Name + " is installed.\n\nFind it in the Start menu or on your desktop. You can delete this setup file.",
                Name + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            // start the installed copy (not this setup file)
            Process.Start(new ProcessStartInfo(InstalledExe) { UseShellExecute = true });
            return false;
        }
        catch (Exception e)
        {
            if (!Quiet) MessageBox.Show("Setup could not finish:\n" + e.Message, Name + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 1;
            return false;
        }
    }

    public static void Uninstall()
    {
        if (Ask("Remove " + Name + " from this computer?", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, DialogResult.OK) != DialogResult.OK) return;
        bool wipeData = Ask("Also delete your saved signatures, auto-fill profiles and settings?\n\n(Choose No to keep them for a future install.)",
            MessageBoxButtons.YesNo, MessageBoxIcon.Question, DialogResult.No) == DialogResult.Yes;
        foreach (var l in new[] { StartMenuLink, DesktopLink }) try { File.Delete(l); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\" + ProgId, false); } catch { }
        try { using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\.pdf\OpenWithProgids", true)) if (k != null) k.DeleteValue(ProgId, false); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\" + Name + ".exe", false); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Key, false); } catch { }
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        // the running exe can't delete itself – a short hidden command does it right after we exit
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PDFEditor");
        string cmd = "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + InstallDir + "\"" + (wipeData ? " & rmdir /s /q \"" + data + "\"" : "");
        Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
        if (!Quiet) MessageBox.Show(Name + " has been removed.", Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    static void Shortcut(string path)
    {
        // Windows Script Host shortcut object (late-bound, no extra references)
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { InstalledExe });
        lt.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { InstallDir });
        lt.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { InstalledExe + ",0" });
        lt.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { "Edit, sign and organize PDF files" });
        lt.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, lnk, null);
        Marshal.FinalReleaseComObject(lnk); Marshal.FinalReleaseComObject(shell);
    }
}
