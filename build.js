// Mark's Render PDF Editor – bundles src/ + libraries into ONE portable file: dist/PDFEditor.html
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'src');
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const read = f => fs.readFileSync(path.resolve(dir, f), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>\n${read(f)}\n</style>`);
html = html.replace(/<script src="([^"]+)" data-worker><\/script>/g, (_, f) =>
  `<script type="text/plain" id="pdfWorkerSrc">\n${read(f).replace(/<\/script/gi, '<\\/script')}\n</script>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) =>
  `<script>\n${read(f).replace(/<\/script/gi, '<\\/script')}\n</script>`);
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'launcher', 'icon-256.png')).toString('base64');
html = html.split('../launcher/icon-256.png').join(icon);
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const out = path.join(__dirname, 'dist', 'PDFEditor.html');
fs.writeFileSync(out, html);
console.log('Built', out, (fs.statSync(out).size / 1048576).toFixed(2) + ' MB');

// Wrap it into a portable PDFEditor.exe using the C# compiler that ships with Windows
const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
if (process.platform === 'win32' && fs.existsSync(csc)) {
  const exe = path.join(__dirname, 'dist', "Mark's Render PDF Editor.exe");
  fs.rmSync(exe, { force: true }); // never ship a stale exe if compiling fails
  // the app goes into the exe gzip-compressed (about a third of the size); version comes from package.json
  const os = require('os'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpdf-'));
  const gz = path.join(tmp, 'PDFEditor.html.gz'), ver = path.join(tmp, 'Version.cs');
  fs.writeFileSync(gz, require('zlib').gzipSync(fs.readFileSync(out), { level: 9 }));
  fs.writeFileSync(ver, `static class AppInfo { public const string Version = "${require('./package.json').version}"; }`);
  require('child_process').execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+',
    `/out:${exe}`, `/win32icon:${path.join(__dirname, 'launcher', 'icon.ico')}`,
    `/resource:${gz},PDFEditor.html.gz`, `/resource:${path.join(__dirname, 'launcher', 'icon-256.png')},logo.png`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    // Windows Runtime (for the built-in OCR engine)
    ...['Foundation', 'Media', 'Graphics', 'Storage'].map(n => `/r:C:/Windows/System32/WinMetadata/Windows.${n}.winmd`),
    '/r:C:/Windows/Microsoft.NET/Framework64/v4.0.30319/System.Runtime.dll',
    '/r:C:/Windows/Microsoft.NET/Framework64/v4.0.30319/System.Runtime.WindowsRuntime.dll',
    path.join(__dirname, 'launcher', 'Launcher.cs'), path.join(__dirname, 'launcher', 'Setup.cs'), path.join(__dirname, 'launcher', 'Taskbar.cs'), ver], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Built', exe, (fs.statSync(exe).size / 1048576).toFixed(2) + ' MB');
} else if (process.env.CI) throw new Error('C# compiler not found: ' + csc);
