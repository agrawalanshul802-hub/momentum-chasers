import os
import subprocess

chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
html_file = r"d:\NEW PROJECT\mini project\mini_project_report_drawio.html"
pdf_file = r"d:\NEW PROJECT\mini project\Mini_Project_Report_Anshul_Agrawal_DrawIO.pdf"

cmd = [
    chrome_path,
    "--headless=new",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    f"--print-to-pdf={pdf_file}",
    f"file:///{html_file.replace(os.sep, '/')}"
]

print("Rendering Draw.io PDF...")
res = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
print("Return code:", res.returncode)
if os.path.exists(pdf_file):
    print(f"Success! PDF generated: {pdf_file} (Size: {os.path.getsize(pdf_file)} bytes)")
else:
    print("Failed:", res.stderr)
