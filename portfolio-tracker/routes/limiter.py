# routes/limiter.py
# Shared Flask-Limiter instance for the entire application.
#
# Why a separate module?
#   Flask blueprints cannot import directly from app.py (circular imports).
#   By creating the Limiter here and calling limiter.init_app(app) in app.py,
#   every blueprint can safely do:  from routes.limiter import limiter
#
# Storage: in-memory (default) — fine for Render free tier (1 worker, 1 instance).
# To scale to multi-worker/multi-instance, replace with Redis:
#   from flask_limiter.util import get_remote_address
#   limiter = Limiter(get_remote_address, storage_uri="redis://localhost:6379")

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    get_remote_address,
    # Global fallback limits — individual routes can override with stricter ones.
    # 300/day, 60/hour, 20/minute per IP address.
    default_limits=["300 per day", "60 per hour", "20 per minute"]
)
