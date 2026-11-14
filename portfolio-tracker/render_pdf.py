import os
import subprocess
import time

html_file = r"d:\NEW PROJECT\mini project\mini_project_report.html"
pdf_file = r"d:\NEW PROJECT\mini project\Mini_Project_Report_Anshul_Agrawal.pdf"

chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
if not os.path.exists(chrome_path):
    chrome_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

print(f"Using browser: {chrome_path}")

cmd = [
    chrome_path,
    "--headless=new",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    f"--print-to-pdf={pdf_file}",
    f"file:///{html_file.replace(os.sep, '/')}"
]

print("Executing command:", " ".join(cmd))
res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
print("Return code:", res.returncode)
if os.path.exists(pdf_file):
    print(f"Success! PDF generated: {pdf_file} (Size: {os.path.getsize(pdf_file)} bytes)")
else:
    print("PDF was not created. Error output:", res.stderr)
