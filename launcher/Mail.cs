// Opens a new email in the user's email program with the PDF already attached (Simple MAPI).
// Works with classic Outlook, Thunderbird and other MAPI mail programs. If there is none
// (e.g. Gmail in a browser or the new Outlook), the page falls back to a mailto: link.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

static class Mailer
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    class MapiMessageW
    {
        public int reserved; public string subject; public string noteText; public string messageType;
        public string dateReceived; public string conversationID; public int flags; public IntPtr originator;
        public int recipCount; public IntPtr recips; public int fileCount; public IntPtr files;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MapiRecipDescW { public int reserved; public int recipClass; public string name; public string address; public int eIDSize; public IntPtr entryID; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MapiFileDescW { public int reserved; public int flags; public int position; public string pathName; public string fileName; public IntPtr fileType; }

    [DllImport("MAPI32.DLL", CharSet = CharSet.Unicode)]
    static extern int MAPISendMailW(IntPtr session, IntPtr uiParam, MapiMessageW message, int flags, int reserved);

    const int MAPI_LOGON_UI = 0x1, MAPI_DIALOG = 0x8, MAPI_TO = 1, MAPI_CC = 2, MAPI_USER_ABORT = 1;

    public static string Send(byte[] body)
    {
        try
        {
            var o = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<Dictionary<string, object>>(System.Text.Encoding.UTF8.GetString(body));
            Func<string, string> get = k => o.ContainsKey(k) && o[k] != null ? o[k].ToString() : "";
            // the attachment goes in a private temp folder (old ones are cleaned up)
            string dir = Path.Combine(Path.GetTempPath(), "MarksRenderPDF-mail");
            Directory.CreateDirectory(dir);
            foreach (var f in Directory.GetFiles(dir)) if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-1)) try { File.Delete(f); } catch { }
            string name = string.Join("_", Path.GetFileName(get("name")).Split(Path.GetInvalidFileNameChars()));
            if (name.Length == 0) name = "document.pdf";
            string sub = Path.Combine(dir, Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(sub);
            string file = Path.Combine(sub, name);
            File.WriteAllBytes(file, Convert.FromBase64String(get("b64")));

            int rc = -1;
            var t = new Thread(() => rc = SendMapi(get("to"), get("cc"), get("subject"), get("body"), file, name));
            t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
            return (rc == 0 || rc == MAPI_USER_ABORT) ? "{\"ok\":true}" : "{\"ok\":false,\"code\":" + rc + "}";
        }
        catch (Exception e) { return "{\"ok\":false,\"error\":\"" + e.Message.Replace("\\", "\\\\").Replace("\"", "'") + "\"}"; }
    }

    static int SendMapi(string to, string cc, string subject, string text, string file, string name)
    {
        var recips = new List<MapiRecipDescW>();
        foreach (var a in to.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)) recips.Add(new MapiRecipDescW { recipClass = MAPI_TO, name = a.Trim(), address = "SMTP:" + a.Trim() });
        foreach (var a in cc.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)) recips.Add(new MapiRecipDescW { recipClass = MAPI_CC, name = a.Trim(), address = "SMTP:" + a.Trim() });
        int rsize = Marshal.SizeOf(typeof(MapiRecipDescW)), fsize = Marshal.SizeOf(typeof(MapiFileDescW));
        IntPtr rp = Marshal.AllocHGlobal(rsize * Math.Max(1, recips.Count)), fp = Marshal.AllocHGlobal(fsize);
        try
        {
            for (int i = 0; i < recips.Count; i++) Marshal.StructureToPtr(recips[i], new IntPtr(rp.ToInt64() + i * rsize), false);
            Marshal.StructureToPtr(new MapiFileDescW { position = -1, pathName = file, fileName = name }, fp, false);
            var msg = new MapiMessageW { subject = subject, noteText = text, recipCount = recips.Count, recips = rp, fileCount = 1, files = fp };
            return MAPISendMailW(IntPtr.Zero, IntPtr.Zero, msg, MAPI_LOGON_UI | MAPI_DIALOG, 0);
        }
        catch { return -1; }
        finally
        {
            for (int i = 0; i < recips.Count; i++) Marshal.DestroyStructure(new IntPtr(rp.ToInt64() + i * rsize), typeof(MapiRecipDescW));
            Marshal.DestroyStructure(fp, typeof(MapiFileDescW));
            Marshal.FreeHGlobal(rp); Marshal.FreeHGlobal(fp);
        }
    }
}
