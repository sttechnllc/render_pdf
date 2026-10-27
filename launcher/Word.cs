// Converts Word documents to PDF with the copy of Microsoft Word installed on this computer (exact layout).
// Word runs hidden, with macros switched off, and is closed again after each document.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;

static class WordConvert
{
    static readonly object gate = new object();
    public static bool Available() { return Type.GetTypeFromProgID("Word.Application") != null; }

    public static string Convert(byte[] body)
    {
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        try
        {
            if (!Available()) return "{\"ok\":false,\"error\":\"noword\"}";
            var o = json.Deserialize<Dictionary<string, object>>(System.Text.Encoding.UTF8.GetString(body));
            string ext = Path.GetExtension(o.ContainsKey("name") ? o["name"].ToString() : "").ToLowerInvariant();
            if (Array.IndexOf(new[] { ".docx", ".doc", ".rtf", ".odt", ".docm", ".dotx", ".txt" }, ext) < 0) ext = ".docx";
            string dir = Path.Combine(Path.GetTempPath(), "MarksRenderPDF-word", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string src = Path.Combine(dir, "document" + ext), dst = Path.Combine(dir, "document.pdf");
            File.WriteAllBytes(src, System.Convert.FromBase64String(o["b64"].ToString()));
            string err = null;
            lock (gate) // one Word at a time
            {
                var t = new Thread(() => { try { Run(src, dst); } catch (Exception e) { err = (e.InnerException ?? e).Message; } });
                t.SetApartmentState(ApartmentState.STA); t.IsBackground = true; t.Start();
                if (!t.Join(TimeSpan.FromSeconds(120))) err = "Word took too long";
            }
            string result = File.Exists(dst)
                ? "{\"ok\":true,\"b64\":\"" + System.Convert.ToBase64String(File.ReadAllBytes(dst)) + "\"}"
                : "{\"ok\":false,\"error\":" + json.Serialize(err ?? "Word could not convert this file") + "}";
            try { Directory.Delete(dir, true); } catch { }
            return result;
        }
        catch (Exception e) { return "{\"ok\":false,\"error\":" + json.Serialize(e.Message) + "}"; }
    }

    static object Get(object o, string p) { return o.GetType().InvokeMember(p, BindingFlags.GetProperty, null, o, null); }
    static void Set(object o, string p, object v) { o.GetType().InvokeMember(p, BindingFlags.SetProperty, null, o, new[] { v }); }
    static object Call(object o, string m, params object[] a) { return o.GetType().InvokeMember(m, BindingFlags.InvokeMethod, null, o, a); }

    static void Run(string src, string dst)
    {
        object word = Activator.CreateInstance(Type.GetTypeFromProgID("Word.Application")), doc = null;
        try
        {
            Set(word, "Visible", false);
            Set(word, "DisplayAlerts", 0);           // wdAlertsNone
            Set(word, "AutomationSecurity", 3);      // msoAutomationSecurityForceDisable: never run macros
            object m = Type.Missing;
            // FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument (a wrong one: protected files fail instead of prompting)
            doc = Call(Get(word, "Documents"), "Open", src, false, true, false, "\u0001", m, m, m, m, m, m, false);
            Call(doc, "ExportAsFixedFormat", dst, 17); // wdExportFormatPDF
        }
        finally
        {
            try { if (doc != null) Call(doc, "Close", 0); } catch { }
            // never close the user's own documents: only quit a Word that has nothing else open
            try { if ((int)Get(Get(word, "Documents"), "Count") == 0) Call(word, "Quit", 0); } catch { }
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(word);
        }
    }
}
