// Mark's Render PDF Editor – portable launcher. The whole editor (PDFEditor.html) is embedded in this exe.
// It unpacks it to %LOCALAPPDATA%\PDFEditor and opens it as a standalone app window using the
// Edge engine built into Windows. Drop a PDF on the exe (or "Open with") to open it directly.
// While the editor is open, a tiny local-only helper offers Windows' built-in OCR (text recognition).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

static class Launcher
{
    static long lastPing = DateTime.UtcNow.Ticks;   // read/written from several threads -> Interlocked
    static string token;
    static int port;
    static readonly SemaphoreSlim busy = new SemaphoreSlim(2); // at most 2 requests processed at once

    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PDFEditor");
            Directory.CreateDirectory(dir);
            string html = Path.Combine(dir, "PDFEditor.html");
            using (var res = Assembly.GetExecutingAssembly().GetManifestResourceStream("PDFEditor.html"))
            using (var ms = new MemoryStream())
            {
                res.CopyTo(ms);
                byte[] data = ms.ToArray();
                if (!File.Exists(html) || new FileInfo(html).Length != data.Length || !File.ReadAllBytes(html).SequenceEqual(data))
                    File.WriteAllBytes(html, data);
            }

            // one OCR helper for all windows
            bool isServer;
            var mutex = new Mutex(true, "PDFEditor.OcrHelper", out isServer);
            if (isServer) StartServer(dir);

            string hash = "";
            string pend = Path.Combine(dir, "pending");
            Directory.CreateDirectory(pend);
            foreach (var old in Directory.GetFiles(pend))
                if (File.GetLastWriteTimeUtc(old) < DateTime.UtcNow.AddMinutes(-5)) try { File.Delete(old); } catch { }
            if (args.Length > 0 && File.Exists(args[0]))
            {
                string id = Guid.NewGuid().ToString("N");
                string b64 = Convert.ToBase64String(File.ReadAllBytes(args[0]));
                File.WriteAllText(Path.Combine(pend, id + ".js"), "window.__openPending(" + Json(Path.GetFileName(args[0])) + ",\"" + b64 + "\");");
                hash = "#open=" + id;
            }

            string url = new Uri(html).AbsoluteUri + hash;
            string edge = FindEdge();
            if (edge == null) Process.Start(html);
            else
            {
                string profile = Path.Combine(dir, "profile");
                Process.Start(new ProcessStartInfo(edge,
                    "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check " +
                    "--window-size=1400,900 --allow-file-access-from-files") { UseShellExecute = false });
            }

            if (isServer)
            {
                // stay alive while any editor window keeps pinging us
                DateTime start = DateTime.UtcNow;
                try
                {
                    while (DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastPing)) < TimeSpan.FromMinutes(2) || DateTime.UtcNow - start < TimeSpan.FromMinutes(2))
                        Thread.Sleep(5000);
                }
                finally { try { File.Delete(Path.Combine(dir, "server.js")); } catch { } }
            }
            GC.KeepAlive(mutex);
        }
        catch (Exception e)
        {
            MessageBox.Show("Mark's Render PDF Editor could not start:\n" + e.Message, "Mark's Render PDF Editor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void StartServer(string dir)
    {
        string info = Path.Combine(dir, "server.js");
        try { File.Delete(info); } catch { } // never leave an old port/token behind
        TcpListener listener;
        try { listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); } // Windows picks a free random port
        catch { return; }
        port = ((IPEndPoint)listener.LocalEndpoint).Port;
        token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        File.WriteAllText(info, "window.__helper={port:" + port + ",token:\"" + token + "\"};");
        var t = new Thread(() =>
        {
            while (true)
            {
                var c = listener.AcceptTcpClient();
                if (!busy.Wait(0)) { c.Close(); continue; } // too many at once - drop it
                ThreadPool.QueueUserWorkItem(_ => { try { Handle(c); } catch { } finally { c.Close(); busy.Release(); } });
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    static void Handle(TcpClient client)
    {
        var s = client.GetStream();
        s.ReadTimeout = 15000;
        // read headers
        var head = new MemoryStream();
        int last4 = 0, b;
        while ((b = s.ReadByte()) >= 0)
        {
            head.WriteByte((byte)b);
            last4 = (last4 << 8) | b;
            if (last4 == 0x0D0A0D0A) break;
            if (head.Length > 65536) return;
        }
        string[] lines = Encoding.ASCII.GetString(head.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
        string[] req = lines[0].Split(' ');
        if (req.Length < 2) return;
        int len = 0;
        string host = "", origin = null;
        foreach (var l in lines)
        {
            if (l.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) int.TryParse(l.Substring(15).Trim(), out len);
            else if (l.StartsWith("Host:", StringComparison.OrdinalIgnoreCase)) host = l.Substring(5).Trim();
            else if (l.StartsWith("Origin:", StringComparison.OrdinalIgnoreCase)) origin = l.Substring(7).Trim();
        }
        string path = req[1], method = req[0];
        // only our own page (file:// -> Origin "null") talking to 127.0.0.1 - blocks DNS rebinding and other websites
        if (host != "127.0.0.1:" + port || (origin != null && origin != "null")) { Reply(s, 403, "{}"); return; }
        if (method == "OPTIONS") { Reply(s, 204, ""); return; }
        // check the secret before reading (and allocating) any body
        string q = path.Contains("?") ? path.Substring(path.IndexOf('?') + 1) : "";
        bool ok = false;
        foreach (var kv in q.Split('&')) if (kv == "t=" + token) ok = true;
        if (!ok) { Reply(s, 403, "{\"error\":\"forbidden\"}"); return; }
        if (len < 0 || len > 25000000) { Reply(s, 413, "{\"error\":\"too large\"}"); return; }
        byte[] body = new byte[len];
        for (int got = 0; got < len;) { int n = s.Read(body, got, len - got); if (n <= 0) break; got += n; }
        Interlocked.Exchange(ref lastPing, DateTime.UtcNow.Ticks);
        if (path.StartsWith("/ping")) Reply(s, 200, "{\"ok\":true}");
        else if (path.StartsWith("/ocr") && method == "POST") Reply(s, 200, Ocr(body));
        else Reply(s, 404, "{}");
    }

    static void Reply(NetworkStream s, int code, string json)
    {
        byte[] data = Encoding.UTF8.GetBytes(json);
        string h = "HTTP/1.1 " + code + " OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + data.Length +
            "\r\nAccess-Control-Allow-Origin: null\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Connection: close\r\n\r\n";
        byte[] hb = Encoding.ASCII.GetBytes(h);
        s.Write(hb, 0, hb.Length);
        s.Write(data, 0, data.Length);
    }

    static T Wait<T>(IAsyncOperation<T> op)
    {
        while (op.Status == AsyncStatus.Started) Thread.Sleep(5);
        return op.GetResults();
    }

    // Windows' built-in OCR. Returns lines with their pixel boxes.
    static string Ocr(byte[] png)
    {
        try
        {
            var ras = new InMemoryRandomAccessStream();
            var w = new DataWriter(ras);
            w.WriteBytes(png); Wait(w.StoreAsync()); w.DetachStream(); ras.Seek(0);
            var bmp = Wait(Wait(BitmapDecoder.CreateAsync(ras)).GetSoftwareBitmapAsync());
            var engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null) return "{\"error\":\"No OCR language installed in Windows\"}";
            var result = Wait(engine.RecognizeAsync(bmp));
            var sb = new StringBuilder("{\"lines\":[");
            bool first = true;
            foreach (var line in result.Lines)
            {
                double x0 = double.MaxValue, y0 = double.MaxValue, x1 = 0, y1 = 0;
                foreach (var word in line.Words)
                {
                    var r = word.BoundingRect;
                    x0 = Math.Min(x0, r.X); y0 = Math.Min(y0, r.Y); x1 = Math.Max(x1, r.X + r.Width); y1 = Math.Max(y1, r.Y + r.Height);
                }
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"text\":").Append(Json(line.Text)).Append(",\"x\":").Append((int)x0).Append(",\"y\":").Append((int)y0)
                  .Append(",\"w\":").Append((int)(x1 - x0)).Append(",\"h\":").Append((int)(y1 - y0)).Append('}');
            }
            return sb.Append("]}").ToString();
        }
        catch (Exception e) { return "{\"error\":" + Json(e.Message) + "}"; }
    }

    static string Json(string v)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in v)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string FindEdge()
    {
        string[] roots = {
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
        };
        foreach (var r in roots)
        {
            if (string.IsNullOrEmpty(r)) continue;
            string p = Path.Combine(r, @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(p)) return p;
        }
        return null;
    }
}
