# routes/alerts_email.py
# Server-side price alert email dispatch:
#   POST /api/alert-triggered  - Called by frontend when a price alert fires

import os, smtplib, threading
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from flask import Blueprint, jsonify, request, session
from routes import load_env_file
from routes.limiter import limiter

alerts_email_bp = Blueprint('alerts_email', __name__)


@alerts_email_bp.route('/api/alert-triggered', methods=['POST'])
@limiter.limit("30 per minute")
def alert_triggered():
    """Called by JS when a client-side price alert fires. Sends email notification."""
    email = session.get('email')
    if not email:
        return jsonify({'error': 'Not logged in'}), 401

    data = request.get_json() or {}
    symbol       = data.get('symbol', 'Unknown')
    exchange     = data.get('exchange', 'NSE')
    target_price = data.get('targetPrice', 0)
    current_price = data.get('currentPrice', 0)
    direction    = data.get('direction', 'above')  # 'above' or 'below'

    _send_alert_email(email, symbol, exchange, target_price, current_price, direction)
    return jsonify({'success': True})


def _send_alert_email(to_email, symbol, exchange, target_price, current_price, direction):
    def _worker():
        try:
            load_env_file()
            smtp_user = os.getenv('SMTP_EMAIL') or os.getenv('MAIL_USERNAME')
            smtp_pass = os.getenv('SMTP_PASSWORD') or os.getenv('MAIL_PASSWORD')
            smtp_host = os.getenv('SMTP_HOST', 'smtp.gmail.com')
            smtp_port = int(os.getenv('SMTP_PORT', '587'))
            if not smtp_user or not smtp_pass:
                print(f"[Price Alert] SMTP not configured. Alert: {symbol} @ {current_price}")
                return

            emoji = "🚀" if direction == 'above' else "⚠️"
            dir_text = "crossed ABOVE" if direction == 'above' else "dropped BELOW"
            subject = f"{emoji} Price Alert: {symbol} {dir_text} ₹{target_price:.2f}"
            display_name = to_email.split('@')[0].capitalize()
            color = '#10B981' if direction == 'above' else '#EF4444'
            change_pct = ((current_price - target_price) / target_price * 100) if target_price else 0

            html = f"""<!DOCTYPE html><html><body style="font-family:sans-serif;background:#F1F5F9;margin:0;padding:20px;">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;">
  <div style="background:#0F172A;padding:20px 28px;">
    <h2 style="color:#fff;margin:0;font-size:16px;">Portfolio Tracker &mdash; Price Alert</h2>
  </div>
  <div style="padding:28px;">
    <p style="color:#334155;font-size:14.5px;">Hi <strong>{display_name}</strong>,</p>
    <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:20px;text-align:center;margin:16px 0;">
      <div style="font-size:40px;margin-bottom:8px;">{emoji}</div>
      <h3 style="margin:0 0 4px;font-size:20px;color:#0F172A;">{symbol} ({exchange})</h3>
      <p style="color:{color};font-size:22px;font-weight:700;margin:8px 0;">₹{current_price:,.2f}</p>
      <p style="color:#64748B;font-size:14px;margin:0;">Has {dir_text} your target of <strong>₹{target_price:,.2f}</strong></p>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;color:#64748B;">Target Price</td><td style="text-align:right;font-weight:600;">₹{target_price:,.2f}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;">Current Price</td><td style="text-align:right;font-weight:600;color:{color};">₹{current_price:,.2f}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;">Difference</td><td style="text-align:right;font-weight:600;color:{color};">{change_pct:+.2f}%</td></tr>
    </table>
    <p style="color:#94A3B8;font-size:12px;margin-top:20px;">Open your <a href="/" style="color:#6D28D9;">Portfolio Tracker</a> to take action.</p>
  </div>
  <div style="background:#F8FAFC;padding:14px 28px;border-top:1px solid #E2E8F0;font-size:11.5px;color:#64748B;text-align:center;">
    Sent to <strong>{to_email}</strong> &middot; Portfolio Tracker
  </div>
</div></body></html>"""

            msg = MIMEMultipart('alternative')
            msg['Subject'] = subject
            msg['From']    = f"Portfolio Tracker Alerts <{smtp_user}>"
            msg['To']      = to_email
            plain = f"Price Alert: {symbol} ({exchange})\nCurrent: Rs.{current_price:.2f} | Target: Rs.{target_price:.2f}\n{symbol} has {dir_text} your target price."
            msg.attach(MIMEText(plain, 'plain'))
            msg.attach(MIMEText(html, 'html'))
            with smtplib.SMTP(smtp_host, smtp_port, timeout=12) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
                print(f"[Price Alert] Email sent to {to_email} for {symbol}")
        except Exception as e:
            print(f"[Price Alert] Email error: {e}")

    threading.Thread(target=_worker, daemon=True).start()
