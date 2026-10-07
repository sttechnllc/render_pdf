// Mark's Render PDF Editor – built-in installer / uninstaller (per-user, no admin rights needed).
// Runs when the exe is named "...Setup.exe" (or started with --install); uninstall via Settings → Apps.
// --quiet skips all windows (for IT / scripted installs).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup
{
    public const string Name = "Mark's Render PDF Editor";
    const string Key = "MarksRenderPDFEditor";
    const string ProgId = "MarksRenderPDF.pdf";
    public static bool Quiet;

    static string InstallDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); } }
    public static string InstalledExe { get { return Path.Combine(InstallDir, Name + ".exe"); } }
    static string StartMenuLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk"); } }
    static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name + ".lnk"); } }

    [DllImport("shell32.dll")] static extern void SHChangeNotify(int eventId, int flags, IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static void PrepareUi()
    {
        try { SetProcessDPIAware(); } catch { } // sharp text on high-resolution screens
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
    }

    // ---------------- install ----------------
    public static bool Install()
    {
        bool already = File.Exists(InstalledExe);
        if (Quiet) { try { DoInstall(true, true); } catch { Environment.ExitCode = 1; } return false; }
        PrepareUi();
        using (var w = new SetupWindow(already)) Application.Run(w);
        return false;
    }

    public static void DoInstall(bool desktop, bool openWith)
    {
        string self = Application.ExecutablePath;
        Directory.CreateDirectory(InstallDir);
        if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase))
            File.Copy(self, InstalledExe, true);
        Shortcut(StartMenuLink);
        if (desktop) Shortcut(DesktopLink); else try { File.Delete(DesktopLink); } catch { }
        if (openWith)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + ProgId))
            {
                k.SetValue("", "PDF document");
                using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", "\"" + InstalledExe + "\",0");
                using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", "\"" + InstalledExe + "\" \"%1\"");
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.pdf\OpenWithProgids")) k.SetValue(ProgId, new byte[0], RegistryValueKind.None);
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\" + Name + @".exe\SupportedTypes")) k.SetValue(".pdf", "");
        }
        else RemoveOpenWith();
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
    }

    static void RemoveOpenWith()
    {
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\" + ProgId, false); } catch { }
        try { using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\.pdf\OpenWithProgids", true)) if (k != null) k.DeleteValue(ProgId, false); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\" + Name + ".exe", false); } catch { }
    }

    // ---------------- uninstall ----------------
    public static void Uninstall()
    {
        if (Quiet) { DoUninstall(false); return; }
        PrepareUi();
        using (var w = new SetupWindow(true, true)) Application.Run(w);
    }

    public static void DoUninstall(bool wipeData)
    {
        foreach (var l in new[] { StartMenuLink, DesktopLink }) try { File.Delete(l); } catch { }
        RemoveOpenWith();
        try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Key, false); } catch { }
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        // the running exe can't delete itself – a short hidden command does it right after we exit
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PDFEditor");
        string cmd = "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + InstallDir + "\"" + (wipeData ? " & rmdir /s /q \"" + data + "\"" : "");
        Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
    }

    static void Shortcut(string path)
    {
        // Windows Script Host shortcut object (late-bound, no extra references)
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { InstalledExe });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { InstallDir });
        lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { InstalledExe + ",0" });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Edit, sign and organize PDF files" });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        Marshal.FinalReleaseComObject(lnk); Marshal.FinalReleaseComObject(shell);
    }
}

// A clean, branded setup window (install / update / uninstall), drawn with plain WinForms.
class SetupWindow : Form
{
    static readonly Color Accent = Color.FromArgb(37, 99, 235), Danger = Color.FromArgb(220, 38, 38),
        Ink = Color.FromArgb(31, 35, 41), Muted = Color.FromArgb(107, 114, 128), Line = Color.FromArgb(229, 231, 235);
    readonly bool update, uninstall;
    readonly Panel body = new Panel();
    readonly FlatBtn primary, secondary;
    CheckBox cDesktop, cOpenWith, cLaunch, cWipe;

    public SetupWindow(bool alreadyInstalled, bool uninstallMode = false)
    {
        update = alreadyInstalled; uninstall = uninstallMode;
        Text = Setup.Name + (uninstall ? " – Uninstall" : " – Setup");
        Font = new Font("Segoe UI", 10f);
        AutoScaleDimensions = new SizeF(96f, 96f); AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(520, 420);
        FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        // header: logo, name, version
        var logo = new PictureBox { Location = new Point(28, 24), Size = new Size(64, 64), SizeMode = PictureBoxSizeMode.Zoom };
        try { using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png")) logo.Image = Image.FromStream(s); } catch { }
        var title = new Label { Text = Setup.Name, Location = new Point(108, 28), AutoSize = true, ForeColor = Ink, Font = new Font("Segoe UI Semibold", 15f) };
        var sub = new Label { Text = "Version " + AppInfo.Version + "  ·  Free PDF editor", Location = new Point(110, 62), AutoSize = true, ForeColor = Muted };
        var sep = new Panel { Location = new Point(0, 108), Size = new Size(520, 1), BackColor = Line };
        body.Location = new Point(28, 124); body.Size = new Size(464, 220);

        // footer: buttons
        var foot = new Panel { Location = new Point(0, 356), Size = new Size(520, 64), BackColor = Color.FromArgb(248, 249, 251) };
        primary = new FlatBtn(uninstall ? "Uninstall" : update ? "Update" : "Install", uninstall ? Danger : Accent, Color.White) { Location = new Point(384, 14), Size = new Size(112, 36) };
        secondary = new FlatBtn("Cancel", Color.White, Ink) { Location = new Point(262, 14), Size = new Size(112, 36), Border = Line };
        primary.Click += (s, e) => Run(); secondary.Click += (s, e) => Close();
        foot.Controls.AddRange(new Control[] { primary, secondary });
        Controls.AddRange(new Control[] { logo, title, sub, sep, body, foot });
        AcceptButton = primary; CancelButton = secondary;
        if (uninstall) ShowUninstallOptions(); else ShowInstallOptions();
    }

    Label Text2(string t, int y, Color c, float size = 10f, bool bold = false)
    {
        var l = new Label { Text = t, Location = new Point(0, y), Size = new Size(464, 0), AutoSize = false, ForeColor = c,
            Font = new Font(bold ? "Segoe UI Semibold" : "Segoe UI", size) };
        l.Height = TextRenderer.MeasureText(t, l.Font, new Size(464, 0), TextFormatFlags.WordBreak).Height + 4;
        body.Controls.Add(l); return l;
    }
    CheckBox Check(string t, int y, bool on)
    {
        var c = new CheckBox { Text = t, Location = new Point(0, y), AutoSize = true, Checked = on, ForeColor = Ink, Cursor = Cursors.Hand };
        body.Controls.Add(c); return c;
    }

    void ShowInstallOptions()
    {
        Text2(update ? "Updating keeps your signatures, profiles and settings." : "Edit, sign and organize PDFs – everything stays on this computer.", 0, Muted);
        Check("Add to the Start menu", 58, true).Enabled = false;
        cDesktop = Check("Create a desktop shortcut", 88, true);
        cOpenWith = Check("Add to \"Open with\" for PDFs (your default app stays)", 118, true);
        cLaunch = Check("Open the editor when finished", 148, true);
        Text2("Just for you  ·  no admin rights  ·  remove anytime in Settings → Apps", 192, Muted, 8.5f);
    }
    void ShowUninstallOptions()
    {
        Text2("This removes the program, its shortcuts and its \"Open with\" entry.", 0, Ink);
        cWipe = Check("Also delete my saved signatures and profiles", 72, false);
        Text2("Leave this unticked to keep them for a future install.", 102, Muted, 9f);
    }

    void Done(string headline, string text, bool offerOpen)
    {
        body.Controls.Clear();
        var tick = new Label { Text = "✔", Location = new Point(0, 4), AutoSize = true, ForeColor = Color.FromArgb(22, 163, 74), Font = new Font("Segoe UI Symbol", 22f) };
        body.Controls.Add(tick);
        var h = new Label { Text = headline, Location = new Point(44, 10), AutoSize = true, ForeColor = Ink, Font = new Font("Segoe UI Semibold", 13f) };
        body.Controls.Add(h);
        Text2(text, 60, Muted);
        secondary.Text = "Close"; secondary.Visible = true;
        if (offerOpen) { primary.Text = "Open"; primary.Back = Accent; primary.Visible = true; primary.Enabled = true; }
        else primary.Visible = false;
        AcceptButton = offerOpen ? (IButtonControl)primary : secondary;
    }

    bool finished;
    void Run()
    {
        if (finished) { Process.Start(new ProcessStartInfo(Setup.InstalledExe) { UseShellExecute = true }); Close(); return; }
        primary.Enabled = false; secondary.Enabled = false; Cursor = Cursors.WaitCursor; Refresh();
        try
        {
            if (uninstall)
            {
                Setup.DoUninstall(cWipe.Checked);
                finished = true; Cursor = Cursors.Default; secondary.Enabled = true;
                Done("Uninstalled", Setup.Name + " has been removed from this computer." + (cWipe.Checked ? "" : " Your saved signatures and profiles were kept."), false);
                return;
            }
            Setup.DoInstall(cDesktop.Checked, cOpenWith.Checked);
            finished = true; Cursor = Cursors.Default; secondary.Enabled = true;
            if (cLaunch.Checked) { Process.Start(new ProcessStartInfo(Setup.InstalledExe) { UseShellExecute = true }); Close(); return; }
            Done(update ? "Updated" : "Installed", "Find it in the Start menu" + (cDesktop.Checked ? " or on your desktop" : "") + ". You can delete the setup file now.", true);
        }
        catch (Exception ex)
        {
            Cursor = Cursors.Default; primary.Enabled = true; secondary.Enabled = true;
            MessageBox.Show(this, "Setup could not finish:\n\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

// Flat, rounded button in the app's style
class FlatBtn : Button
{
    public Color Back, Fore, Border = Color.Empty;
    public FlatBtn(string text, Color back, Color fore)
    {
        Text = text; Back = back; Fore = fore; FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand; Font = new Font("Segoe UI Semibold", 10f);
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
    bool hover;
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Parent != null ? Parent.BackColor : Color.White);
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        Color fill = !Enabled ? Color.FromArgb(160, Back) : hover ? ControlPaint.Dark(Back, 0.05f) : Back;
        using (var path = Round(r, 8))
        {
            using (var b = new SolidBrush(fill)) g.FillPath(b, path);
            if (Border != Color.Empty) using (var p = new Pen(Border)) g.DrawPath(p, path);
        }
        TextRenderer.DrawText(g, Text, Font, r, Fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
    static GraphicsPath Round(Rectangle r, int rad)
    {
        var p = new GraphicsPath(); int d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure();
        return p;
    }
}
