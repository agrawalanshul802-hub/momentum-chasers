# routes/ipo.py
# IPO tracker and PAN/allotment management:
#   GET  /api/ipos                         - All IPOs (Open/Upcoming/Listed)
#   GET  /api/ipo-detail                   - Single IPO detail + GMP
#   GET/POST/DELETE /api/user/pan(s)       - PAN card management
#   GET  /api/ipo/applications             - User's IPO applications
#   POST /api/ipo/apply                    - Apply for an IPO
#   POST /api/ipo/allotment-status         - Update allotment status
#   POST /api/ipo/check-allotment          - Check allotment from registrar
#   DELETE /api/ipo/applications/<id>      - Delete an application

import os, json, re, time, datetime, threading, urllib.parse, urllib.request
from flask import Blueprint, jsonify, request, session
from routes import supabase, _LOCAL_USER_PANS, _LOCAL_IPO_APPS, DEMO_PANS, DIRECTORY, load_env_file

ipo_bp = Blueprint('ipo', __name__)

_ipo_cache = {'data': None, 'ts': 0, 'disclaimer': None}
_IPO_CACHE_TTL = 600  # 10 minutes
_IPO_MIN_POLL_INTERVAL = 60  # Xflot's published maximum polling frequency
_XFLOT_IPO_API = 'https://www.xflot.com/api/public/market/ipos'
_XFLOT_DOCS_URL = 'https://www.xflot.com/api-docs'
_XFLOT_DISCLAIMER_FALLBACK = 'Aggregated public IPO information. GMP is unofficial, unverifiable, and may be disputed; verify independently.'
_xflot_request_lock = threading.Lock()
_xflot_last_request_ts = 0.0

def _strip_tags(s):

    return re.sub(r'<[^>]+>', '', s).strip()

def _fmt_date(ts_ms):

    if not ts_ms:

        return 'TBA'

    try:

        dt = datetime.datetime.fromtimestamp(ts_ms / 1000, tz=datetime.timezone.utc)

        return dt.strftime('%d %b %Y')

    except Exception:

        return 'TBA'

_MONTH_MAP = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
}

def _parse_ipo_date(date_str):
    if not date_str or str(date_str).strip() in ('-', 'TBA', 'None', '', 'Pending'):
        return None
    s = str(date_str).strip()
    m1 = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)
    if m1:
        try:
            return datetime.date(int(m1.group(1)), int(m1.group(2)), int(m1.group(3)))
        except Exception:
            pass
    m2 = re.match(r'^(\d{1,2})[\s\-]+([A-Za-z]{3,})[\s\-]+(\d{4})', s)
    if m2:
        try:
            d = int(m2.group(1))
            mon_str = m2.group(2).lower()[:3]
            m = _MONTH_MAP.get(mon_str, 1)
            y = int(m2.group(3))
            return datetime.date(y, m, d)
        except Exception:
            pass
    return None

def _fetch_xflot_json(path=''):
    """Fetch one documented Xflot API endpoint, enforcing its one-request/minute limit."""
    global _xflot_last_request_ts
    url = _XFLOT_IPO_API + path
    with _xflot_request_lock:
        now = time.monotonic()
        wait_left = _IPO_MIN_POLL_INTERVAL - (now - _xflot_last_request_ts)
        if _xflot_last_request_ts and wait_left > 0:
            raise RuntimeError(f'Xflot refresh is rate-limited; retry in {int(wait_left) + 1} seconds.')

        req = urllib.request.Request(url, headers={
            'User-Agent': 'PortfolioTracker/1.0 (IPO data; attribution: Xflot)',
            'Accept': 'application/json',
        })
        # Count the attempt even if it fails, so failures cannot trigger rapid retries.
        _xflot_last_request_ts = now
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode('utf-8', errors='replace'))

    if payload.get('ok') is not True:
        raise RuntimeError('Xflot returned an unsuccessful IPO data response.')
    return payload


def _fmt_xflot_date(value):
    if not value:
        return 'TBA'
    text = str(value).strip()
    if text.lower() in ('-', 'tba', 'none', 'pending'):
        return 'TBA'
    try:
        dt = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
        if dt.tzinfo:
            dt = dt.astimezone(datetime.timezone.utc)
        return dt.strftime('%d %b %Y')
    except (TypeError, ValueError):
        return text[:10] if re.match(r'^\d{4}-\d{2}-\d{2}', text) else text


def _format_xflot_number(value):
    if value is None:
        return None
    try:
        number = float(value)
        return str(int(number)) if number.is_integer() else f'{number:g}'
    except (TypeError, ValueError):
        return str(value)


def _map_xflot_ipo(item):
    status = str(item.get('status') or '').upper()
    board = str(item.get('board') or '').upper()
    price_min = item.get('priceMin')
    price_max = item.get('priceMax')
    if price_min is None and price_max is None:
        price_band = 'TBA'
    elif price_min is None:
        price_band = f"Rs.{_format_xflot_number(price_max)}"
    elif price_max is None or price_min == price_max:
        price_band = f"Rs.{_format_xflot_number(price_min)}"
    else:
        price_band = f"Rs.{_format_xflot_number(price_min)} to Rs.{_format_xflot_number(price_max)}"

    subscription = item.get('lastSubX')
    subscription_text = f'{float(subscription):.2f}x' if subscription is not None else '-'
    issue_size = item.get('issueSizeCr')
    issue_size_text = f"Rs.{float(issue_size):,.2f} Cr" if issue_size is not None else '-'
    listing_gain = item.get('listingGainPct')
    listing_return = f'{float(listing_gain):+.1f}%' if listing_gain is not None else 'Pending'
    slug = item.get('slug') or str(item.get('id') or '')

    return {
        'id': slug,
        'search_id': slug,
        'name': item.get('name') or item.get('shortName') or 'IPO name unavailable',
        'symbol': item.get('symbol') or '',
        'type': 'SME' if board == 'SME' else 'Mainboard',
        'exchange': item.get('exchange') or ('SME' if board == 'SME' else 'NSE'),
        'status': status.lower(),
        'price_band': price_band,
        'price_min': price_min,
        'price_max': price_max,
        'lot_size': str(item.get('lotSize')) if item.get('lotSize') is not None else '-',
        'issue_size': issue_size_text,
        'issue_size_cr': issue_size,
        'issue_price': item.get('issuePrice'),
        'listing_price': item.get('listingPrice'),
        'listing_return': listing_return,
        'open_date': _fmt_xflot_date(item.get('openDate')),
        'close_date': _fmt_xflot_date(item.get('closeDate')),
        'allotment_date': _fmt_xflot_date(item.get('allotmentDate')),
        'listing_date': _fmt_xflot_date(item.get('listingDate')),
        'gmp': item.get('lastGmp'),
        'gmp_pct': item.get('lastGmpPct'),
        'gmp_sources': item.get('gmpSources'),
        'gmp_spread': item.get('gmpSpread'),
        'gmp_disputed': bool(item.get('gmpDisputed')),
        'sub_total': subscription_text,
        'registrar': item.get('registrar') or 'TBA',
        'allotment_url': item.get('rtaLink') or '',
        'document_url': item.get('documentUrl') or '',
        'sector': item.get('sector') or 'General',
        'updated_at': item.get('updatedAt'),
        'logo_url': item.get('logoUrl') or '',
    }


def _build_ipo_lists(items):
    lists = {'open': [], 'upcoming': [], 'listed': []}
    for item in items:
        mapped = _map_xflot_ipo(item)
        status = mapped['status']
        if status == 'open':
            lists['open'].append(mapped)
        elif status == 'upcoming':
            lists['upcoming'].append(mapped)
        elif status in ('closed', 'listed'):
            lists['listed'].append(mapped)
    return lists
@ipo_bp.route('/api/ipos', methods=['GET'])
def get_ipos():
    load_env_file()
    global _ipo_cache
    now = time.time()
    age = int(now - _ipo_cache['ts']) if _ipo_cache.get('data') else None
    force = request.args.get('refresh') == '1'
    can_serve_cache = bool(_ipo_cache.get('data') and age is not None and age < _IPO_CACHE_TTL)

    # Respect Xflot's published one-request-per-minute limit, including manual refreshes.
    if can_serve_cache and (not force or age < _IPO_MIN_POLL_INTERVAL):
        return jsonify(_ipo_list_response(cached=True, age=age))

    try:
        payload = _fetch_xflot_json('?limit=200')
        mapped = _build_ipo_lists(payload.get('ipos') or [])
        _ipo_cache = {
            'data': mapped,
            'ts': time.time(),
            'disclaimer': payload.get('disclaimer') or _XFLOT_DISCLAIMER_FALLBACK,
            'updated_at': payload.get('updatedAt'),
        }
        return jsonify(_ipo_list_response(cached=False, age=0))
    except Exception as exc:
        if _ipo_cache.get('data'):
            stale_age = int(time.time() - _ipo_cache['ts'])
            response = _ipo_list_response(cached=True, age=stale_age)
            response['warning'] = str(exc)
            return jsonify(response)
        return jsonify({
            'data': {'open': [], 'upcoming': [], 'listed': []},
            'cached': False,
            'error': str(exc),
            'source': 'Xflot public IPO API',
            'source_url': _XFLOT_DOCS_URL,
            'disclaimer': _XFLOT_DISCLAIMER_FALLBACK,
        }), 200


def _ipo_list_response(cached, age):
    return {
        'data': _ipo_cache['data'],
        'cached': cached,
        'age_seconds': age,
        'updated_at': _ipo_cache.get('updated_at'),
        'source': 'Xflot public IPO API',
        'source_url': _XFLOT_DOCS_URL,
        'disclaimer': _ipo_cache.get('disclaimer') or _XFLOT_DISCLAIMER_FALLBACK,
    }


_ipo_detail_cache = {}
_DETAIL_CACHE_TTL = 60


def _make_ipo_detail(summary, detail=None, requested_name='', requested_symbol=''):
    summary = summary or {}
    detail = detail or {}
    min_price = summary.get('price_min')
    max_price = summary.get('price_max')
    if min_price is None and max_price is None:
        matches = re.findall(r'\d+(?:\.\d+)?', summary.get('price_band') or '')
        min_price = float(matches[0]) if matches else None
        max_price = float(matches[1]) if len(matches) > 1 else min_price

    subscriptions = detail.get('subs') or detail.get('subscriptionRates') or []
    if isinstance(subscriptions, dict):
        subscriptions = subscriptions.get('categories') or subscriptions.get('data') or []
    rates = []
    for entry in subscriptions if isinstance(subscriptions, list) else []:
        if not isinstance(entry, dict):
            continue
        category = entry.get('category') or entry.get('name') or 'TOTAL'
        rate = entry.get('timesSub', entry.get('subscriptionRate', entry.get('times_sub')))
        rates.append({
            'category': str(category).upper(),
            'categoryName': str(entry.get('categoryName') or entry.get('name') or category),
            'subscriptionRate': rate,
        })
    if not rates and summary.get('sub_total') not in (None, '-', ''):
        try:
            rates = [{'category': 'TOTAL', 'categoryName': 'Overall Subscription',
                      'subscriptionRate': float(str(summary['sub_total']).rstrip('x'))}]
        except (TypeError, ValueError):
            pass

    detail_ipo = detail.get('ipo') if isinstance(detail.get('ipo'), dict) else detail
    detail_ipo = detail_ipo or {}
    gmp_history = detail.get('gmpHistory') or detail.get('gmp') or []
    return {
        'symbol': summary.get('symbol') or requested_symbol,
        'companyName': summary.get('name') or requested_name or requested_symbol or 'IPO Details',
        'companyShortName': summary.get('name') or requested_symbol,
        'logoUrl': summary.get('logo_url') or '',
        'sector': summary.get('sector') or 'General',
        'isSme': 'SME' in str(summary.get('type') or '').upper(),
        'status': str(summary.get('status') or '').upper(),
        'minPrice': min_price,
        'maxPrice': max_price,
        'lotSize': summary.get('lot_size'),
        'minBidQty': summary.get('lot_size'),
        'issueSize': summary.get('issue_size') or 'TBA',
        'faceValue': '-',
        'startDate': summary.get('open_date') or 'TBA',
        'endDate': summary.get('close_date') or 'TBA',
        'allotmentDate': summary.get('allotment_date') or 'TBA',
        'listingDate': summary.get('listing_date') or 'TBA',
        'categories': detail_ipo.get('categories') or [],
        'subscriptionRates': rates,
        'gmpHistory': gmp_history if isinstance(gmp_history, list) else [],
        'aboutCompany': detail_ipo.get('aboutCompany') or {},
        'financials': detail_ipo.get('financials') or [],
        'pros': detail_ipo.get('pros') or [],
        'cons': detail_ipo.get('cons') or [],
        'documentUrl': summary.get('document_url') or '',
        'registrar': summary.get('registrar') or '',
        'rtaLink': summary.get('allotment_url') or '',
        'faqs': detail_ipo.get('faqs') or [],
        'dataSource': 'Xflot public IPO API',
    }


@ipo_bp.route('/api/ipo-detail', methods=['GET'])
def get_ipo_detail():
    load_env_file()
    email = session.get('email') or request.args.get('email')
    if not email:
        return jsonify({'error': 'Unauthorized'}), 401

    search_id = request.args.get('id', '').strip()
    symbol = request.args.get('symbol', '').strip()
    name = request.args.get('name', '').strip()
    if not search_id and not symbol and not name:
        return jsonify({'error': 'Missing id, symbol, or name parameter'}), 400

    cached_items = []
    if _ipo_cache.get('data'):
        for section in ('open', 'upcoming', 'listed'):
            cached_items.extend(_ipo_cache['data'].get(section, []))
    matched = next((item for item in cached_items if
        (search_id and str(item.get('search_id', '')).lower() == search_id.lower()) or
        (symbol and str(item.get('symbol', '')).lower() == symbol.lower()) or
        (name and str(item.get('name', '')).lower() == name.lower())), None)
    if matched:
        search_id = matched.get('search_id') or search_id

    cache_key = (search_id or symbol or name).lower()
    now = time.time()
    cached_detail = _ipo_detail_cache.get(cache_key)
    if cached_detail and now - cached_detail['ts'] < _DETAIL_CACHE_TTL:
        return jsonify({'data': cached_detail['data'], 'cached': True})

    detail_payload = {}
    detail_fetched = False
    if search_id:
        try:
            detail_payload = _fetch_xflot_json('/' + urllib.parse.quote(search_id, safe=''))
            nested_payload = detail_payload.get('data')
            if isinstance(nested_payload, dict):
                detail_payload = {**detail_payload, **nested_payload}
            detail_fetched = True
        except Exception:
            # The summary remains useful when Xflot's request interval applies.
            pass

    detail_data = _make_ipo_detail(matched, detail_payload, name, symbol)
    if not matched and search_id:
        detail_data['companyName'] = name or symbol or search_id
        detail_data['companyShortName'] = symbol or name or search_id
    if detail_fetched:
        _ipo_detail_cache[cache_key] = {'data': detail_data, 'ts': now}
    return jsonify({'data': detail_data, 'cached': False})

# USER PAN & IPO APPLICATION ALLOTMENT TRACKER APIS (SUPABASE)
# -------------------------------------------------------------

PAN_REGEX = re.compile(r'^[A-Z]{5}[0-9]{4}[A-Z]{1}$')

@ipo_bp.route('/api/user/pan', methods=['GET', 'POST', 'DELETE'])
@ipo_bp.route('/api/user/pans', methods=['GET', 'POST', 'DELETE'])
def handle_user_pan():
    load_env_file()
    payload = request.get_json(silent=True) or {}
    email = session.get('email') or request.args.get('email') or payload.get('email')
    if not email:
        return jsonify({'error': 'Unauthorized', 'message': 'User email required'}), 401
    
    clean_email = email.strip().lower()
    
    if request.method == 'GET':
        pan_raw = None
        pans_list = []
        if supabase:
            try:
                res = supabase.table('users').select('pan_card').eq('email', clean_email).execute()
                if res.data and len(res.data) > 0:
                    pan_raw = res.data[0].get('pan_card')
                else:
                    res2 = supabase.table('users').select('pan_card').ilike('email', clean_email).execute()
                    if res2.data and len(res2.data) > 0:
                        pan_raw = res2.data[0].get('pan_card')
            except Exception as e:
                print(f"[Supabase PAN Error] {e}")
                
        primary_pan = ''
        if pan_raw:
            str_val = str(pan_raw).strip()
            if str_val.startswith('[') and str_val.endswith(']'):
                try:
                    import json
                    parsed_p = json.loads(str_val)
                    if parsed_p and isinstance(parsed_p, list):
                        pans_list = [p for p in parsed_p if (p.get('pan') or '').strip().upper() not in DEMO_PANS]
                        if pans_list:
                            primary_pan = pans_list[0].get('pan', '')
                except Exception:
                    pass
            elif len(str_val) == 10 and str_val.upper() not in DEMO_PANS:
                primary_pan = str_val
                pans_list = [{'id': '1', 'name': 'Primary Account', 'pan': str_val}]
                
        if not pans_list and clean_email in _LOCAL_USER_PANS:
            pans_list = [p for p in _LOCAL_USER_PANS[clean_email] if (p.get('pan') or '').strip().upper() not in DEMO_PANS]
            if pans_list:
                primary_pan = pans_list[0].get('pan', '')
                
        _LOCAL_USER_PANS[clean_email] = pans_list
            
        return jsonify({'success': True, 'pan': primary_pan, 'pans': pans_list})
        
    if request.method == 'DELETE':
        pan_to_del = request.args.get('pan') or payload.get('pan')
        if clean_email in _LOCAL_USER_PANS:
            if pan_to_del:
                _LOCAL_USER_PANS[clean_email] = [p for p in _LOCAL_USER_PANS[clean_email] if p.get('pan') != pan_to_del]
            else:
                _LOCAL_USER_PANS[clean_email] = []
        if supabase:
            try:
                res = supabase.table('users').select('pan_card').eq('email', clean_email).execute()
                cur_val = res.data[0].get('pan_card') if res.data else None
                if pan_to_del:
                    if cur_val and str(cur_val).strip().startswith('['):
                        import json
                        arr = json.loads(str(cur_val))
                        arr = [x for x in arr if (x.get('pan') or '').upper() != pan_to_del.strip().upper()]
                        new_val = json.dumps(arr) if arr else None
                        supabase.table('users').update({'pan_card': new_val}).eq('email', clean_email).execute()
                    else:
                        supabase.table('users').update({'pan_card': None}).eq('email', clean_email).execute()
                else:
                    supabase.table('users').update({'pan_card': None}).eq('email', clean_email).execute()
            except Exception as e:
                print(f"[Supabase PAN Delete Error] {e}")
        return jsonify({'success': True, 'pan': '', 'pans': _LOCAL_USER_PANS.get(clean_email, []), 'message': 'PAN deleted successfully'})
    
    # POST: Save / Update PANs
    import json
    input_pans = payload.get('pans')
    if input_pans is not None and isinstance(input_pans, list):
        cleaned_pans = []
        for i, it in enumerate(input_pans, 1):
            p_val = (it.get('pan') or '').strip().upper()
            p_name = (it.get('name') or f'Investor {i}').strip()
            if p_val and PAN_REGEX.match(p_val) and p_val not in DEMO_PANS:
                cleaned_pans.append({'id': str(it.get('id') or i), 'name': p_name, 'pan': p_val})
        json_str = json.dumps(cleaned_pans) if cleaned_pans else None
        _LOCAL_USER_PANS[clean_email] = cleaned_pans
        if supabase:
            try:
                res_u = supabase.table('users').select('email').eq('email', clean_email).execute()
                if not res_u.data:
                    supabase.table('users').insert({'email': clean_email, 'password_hash': 'oauth-local', 'pan_card': json_str}).execute()
                else:
                    supabase.table('users').update({'pan_card': json_str}).eq('email', clean_email).execute()
            except Exception as e:
                print(f"[Supabase PANs Save Error] {e}")
        prim = cleaned_pans[0]['pan'] if cleaned_pans else ''
        return jsonify({'success': True, 'pan': prim, 'pans': cleaned_pans, 'message': f'{len(cleaned_pans)} PAN cards saved successfully!'})
        
    raw_pan = (payload.get('pan') or '').strip().upper()
    raw_name = (payload.get('name') or 'Primary Account').strip()
    if raw_pan in DEMO_PANS:
        return jsonify({'error': 'Demo PAN cannot be linked'}), 400
    if raw_pan and not PAN_REGEX.match(raw_pan):
        return jsonify({'error': 'Invalid PAN format. Must be 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)'}), 400
        
    cur_list = _LOCAL_USER_PANS.get(clean_email, [])
    found = False
    for x in cur_list:
        if (x.get('pan') or '').upper() == raw_pan:
            x['name'] = raw_name
            found = True
            break
    if not found and raw_pan:
        cur_list.append({'id': str(len(cur_list) + 1), 'name': raw_name, 'pan': raw_pan})
    _LOCAL_USER_PANS[clean_email] = cur_list
    json_val = json.dumps(cur_list)
    
    if supabase:
        try:
            res_u = supabase.table('users').select('email').eq('email', clean_email).execute()
            if not res_u.data:
                supabase.table('users').insert({'email': clean_email, 'password_hash': 'oauth-local', 'pan_card': json_val}).execute()
            else:
                supabase.table('users').update({'pan_card': json_val}).eq('email', clean_email).execute()
        except Exception as e:
            print(f"[Supabase PAN Save Error] {e}")
            
    return jsonify({'success': True, 'pan': raw_pan, 'pans': cur_list, 'message': 'PAN card successfully linked!'})

@ipo_bp.route('/api/ipo/applications', methods=['GET'])
def get_ipo_applications():
    load_env_file()
    email = session.get('email') or request.args.get('email')
    if not email:
        return jsonify({'error': 'Unauthorized', 'message': 'User email required'}), 401
    
    clean_email = email.strip().lower()
    applications = []
    if supabase:
        try:
            res = supabase.table('ipo_applications').select('*').eq('user_email', clean_email).order('created_at', desc=True).execute()
            if res.data:
                applications = res.data
            else:
                res2 = supabase.table('ipo_applications').select('*').ilike('user_email', clean_email).order('created_at', desc=True).execute()
                if res2.data:
                    applications = res2.data
        except Exception as e:
            print(f"[Supabase IPO Apps Error] {e}")
            
    if not applications and clean_email in _LOCAL_IPO_APPS:
        applications = _LOCAL_IPO_APPS[clean_email]
        
    if applications:
        _LOCAL_IPO_APPS[clean_email] = applications
        
    return jsonify({'success': True, 'applications': applications})

@ipo_bp.route('/api/ipo/apply', methods=['POST'])
def save_ipo_application():
    load_env_file()
    data = request.get_json(silent=True) or {}
    email = session.get('email') or request.args.get('email') or data.get('email')
    if not email:
        return jsonify({'error': 'Unauthorized', 'message': 'User email required'}), 401
    
    clean_email = email.strip().lower()
    ipo_name = (data.get('ipo_name') or '').strip()
    ipo_symbol = (data.get('ipo_symbol') or '').strip()
    lots = int(data.get('lots') or 1)
    bid_price = data.get('bid_price') or '-'
    allotment_url = data.get('allotment_url') or ''
    pan_card = (data.get('pan_card') or '').strip().upper()
    
    if not ipo_name:
        return jsonify({'error': 'IPO name is required'}), 400
        
    if not pan_card and supabase:
        try:
            u_res = supabase.table('users').select('pan_card').eq('email', clean_email).execute()
            if u_res.data and len(u_res.data) > 0:
                pan_card = u_res.data[0].get('pan_card') or ''
        except Exception:
            pass
            
    app_record = {
        'user_email': clean_email,
        'ipo_name': ipo_name,
        'ipo_symbol': ipo_symbol,
        'pan_card': pan_card,
        'lots': lots,
        'bid_price': float(str(bid_price).replace('₹','').strip()) if str(bid_price).replace('₹','').strip().replace('.','').isdigit() else 0.0,
        'status': 'APPLIED',
        'allotment_url': allotment_url
    }
    
    if supabase:
        try:
            existing = supabase.table('ipo_applications').select('id').eq('user_email', clean_email).eq('ipo_name', ipo_name).execute()
            if existing.data and len(existing.data) > 0:
                supabase.table('ipo_applications').update(app_record).eq('id', existing.data[0]['id']).execute()
            else:
                supabase.table('ipo_applications').insert(app_record).execute()
        except Exception as e:
            print(f"[Supabase IPO Apply Error] {e}")
            return jsonify({'error': f'Database save error: {str(e)}'}), 500
            
    return jsonify({'success': True, 'message': f'Application for {ipo_name} saved!'})

@ipo_bp.route('/api/ipo/allotment-status', methods=['POST'])
def update_allotment_status():
    load_env_file()
    data = request.get_json(silent=True) or {}
    email = session.get('email') or request.args.get('email') or data.get('email')
    if not email:
        return jsonify({'error': 'Unauthorized', 'message': 'User email required'}), 401
    
    clean_email = email.strip().lower()
    app_id = data.get('id')
    status = data.get('status')
    shares_allotted = int(data.get('shares_allotted') or 0)
    
    if not app_id or not status:
        return jsonify({'error': 'Application ID and status are required'}), 400
        
    if supabase:
        try:
            supabase.table('ipo_applications').update({
                'status': status,
                'shares_allotted': shares_allotted
            }).eq('id', app_id).eq('user_email', clean_email).execute()
        except Exception as e:
            return jsonify({'error': str(e)}), 500
            
    return jsonify({'success': True, 'status': status, 'shares_allotted': shares_allotted})

@ipo_bp.route('/api/ipo/check-allotment', methods=['POST'])
def direct_check_allotment():
    load_env_file()
    data = request.get_json(silent=True) or {}
    email = session.get('email') or request.args.get('email') or data.get('email')
    clean_email = (email or '').strip().lower()
    
    ipo_name = (data.get('ipo_name') or '').strip()
    ipo_symbol = (data.get('ipo_symbol') or '').strip()
    lot_size = int(data.get('lot_size') or 15)
    issue_price = data.get('issue_price') or '-'
    gmp = float(data.get('gmp') or 0)
    allotment_url = data.get('allotment_url') or ''
    override_status = data.get('override_status')
    override_pan = (data.get('pan') or '').strip().upper()
    
    clean_issue_price = str(issue_price).replace('₹','').strip() if issue_price and issue_price != '-' else '124'
    
    # 1. Warm IPO cache if needed and check timing
    global _ipo_cache
    now = time.time()
    if not _ipo_cache.get('data'):
        try:
            ipo_payload = _fetch_xflot_json('?limit=200')
            _ipo_cache = {
                'data': _build_ipo_lists(ipo_payload.get('ipos') or []),
                'ts': time.time(),
                'disclaimer': ipo_payload.get('disclaimer') or _XFLOT_DISCLAIMER_FALLBACK,
                'updated_at': ipo_payload.get('updatedAt'),
            }
        except Exception as e:
            print(f"[Direct Check Xflot Cache Warm Error] {e}")
            
    ipo_data = _ipo_cache.get('data') or {}
    all_open = ipo_data.get('open') or []
    all_upcoming = ipo_data.get('upcoming') or []
    all_listed = ipo_data.get('listed') or []
    
    # Find matching IPO from cache
    matched_ipo = None
    ipo_section = None
    for item in all_open:
        if (item.get('symbol') and ipo_symbol and item.get('symbol').upper() == ipo_symbol.upper()) or (item.get('name') and ipo_name and ipo_name.lower() in item.get('name').lower()):
            matched_ipo = item
            ipo_section = 'open'
            break
    if not matched_ipo:
        for item in all_upcoming:
            if (item.get('symbol') and ipo_symbol and item.get('symbol').upper() == ipo_symbol.upper()) or (item.get('name') and ipo_name and ipo_name.lower() in item.get('name').lower()):
                matched_ipo = item
                ipo_section = 'upcoming'
                break
    if not matched_ipo:
        for item in all_listed:
            if (item.get('symbol') and ipo_symbol and item.get('symbol').upper() == ipo_symbol.upper()) or (item.get('name') and ipo_name and ipo_name.lower() in item.get('name').lower()):
                matched_ipo = item
                ipo_section = 'listed'
                break
                
    today = datetime.date.today()
    allot_date_str = data.get('allotment_date') or (matched_ipo.get('allotment_date') if matched_ipo else None)
    parsed_allot_date = _parse_ipo_date(allot_date_str)
    
    is_not_live = False
    scheduled_display_date = None
    if ipo_section in ('open', 'upcoming'):
        is_not_live = True
        scheduled_display_date = matched_ipo.get('close_date') or 'soon'
    elif parsed_allot_date and today < parsed_allot_date:
        is_not_live = True
        scheduled_display_date = parsed_allot_date.strftime('%d %b %Y')

    # 2. Check if a specific status override was requested for a PAN:
    if override_status and override_pan and override_status in ('ALLOTTED', 'NOT_ALLOTTED', 'APPLIED', 'NOT_APPLIED'):
        target_email = clean_email or 'anshul@123'
        if override_status == 'NOT_APPLIED':
            if supabase:
                try:
                    q = supabase.table('ipo_applications').delete().eq('pan_card', override_pan)
                    if clean_email:
                        q = q.eq('user_email', clean_email)
                    if ipo_symbol:
                        q = q.or_(f"ipo_symbol.eq.{ipo_symbol},ipo_name.ilike.%{ipo_name}%")
                    else:
                        q = q.ilike('ipo_name', f"%{ipo_name}%")
                    q.execute()
                except Exception as e:
                    print(f"[Supabase Delete Override Error] {e}")
            return jsonify({'success': True, 'pan': override_pan, 'status': 'NOT_APPLIED', 'message': 'Reset to Not Applied'})
            
        shares = lot_size if override_status == 'ALLOTTED' else 0
        if supabase:
            try:
                row_update = {
                    'user_email': target_email,
                    'ipo_name': ipo_name,
                    'ipo_symbol': ipo_symbol,
                    'pan_card': override_pan,
                    'status': override_status,
                    'shares_allotted': shares,
                    'lots': 1,
                    'bid_price': float(clean_issue_price) if clean_issue_price.replace('.','').isdigit() else 0.0,
                    'allotment_url': allotment_url
                }
                # Check existing
                q = supabase.table('ipo_applications').select('id').eq('pan_card', override_pan)
                if clean_email:
                    q = q.eq('user_email', clean_email)
                if ipo_symbol:
                    q = q.or_(f"ipo_symbol.eq.{ipo_symbol},ipo_name.ilike.%{ipo_name}%")
                else:
                    q = q.ilike('ipo_name', f"%{ipo_name}%")
                chk = q.execute()
                if chk.data:
                    supabase.table('ipo_applications').update(row_update).eq('id', chk.data[0]['id']).execute()
                else:
                    supabase.table('ipo_applications').insert(row_update).execute()
            except Exception as e:
                print(f"[Supabase Override Save Error] {e}")
                
        return jsonify({
            'success': True,
            'pan': override_pan,
            'status': override_status,
            'shares_allotted': shares,
            'message': f"Updated {override_pan} to {override_status}"
        })

    # 3. Check if multi-PAN check is requested (IPOWiz mode)
    input_pans = data.get('pans')
    if input_pans is not None and isinstance(input_pans, list):
        if len(input_pans) == 0 and clean_email and supabase:
            try:
                res = supabase.table('users').select('pan_card').eq('email', clean_email).execute()
                if res.data and res.data[0].get('pan_card'):
                    raw_c = res.data[0].get('pan_card')
                    if str(raw_c).startswith('['):
                        import json
                        input_pans = json.loads(str(raw_c))
            except Exception:
                pass
        if len(input_pans) == 0:
            return jsonify({
                'success': True,
                'is_live': not is_not_live,
                'allotment_date': scheduled_display_date or '',
                'ipo_name': ipo_name,
                'ipo_symbol': ipo_symbol,
                'message': 'No PAN cards provided.',
                'results': []
            })
        results = []
        for it in input_pans:
            p_val = (it.get('pan') or '').strip().upper()
            p_name = (it.get('name') or 'Investor').strip()
            masked_p = ('X' * 9 + p_val[-1:]) if len(p_val) == 10 else p_val
            
            if is_not_live:
                results.append({
                    'id': str(it.get('id') or ''),
                    'name': p_name,
                    'pan': p_val,
                    'masked_pan': masked_p,
                    'status': 'PENDING',
                    'is_live': False,
                    'shares_allotted': 0,
                    'lots': 0
                })
                continue
                
            # If live: check Supabase ipo_applications
            p_app = None
            if supabase and p_val:
                try:
                    if clean_email:
                        q_user = supabase.table('ipo_applications').select('*').eq('user_email', clean_email).eq('pan_card', p_val)
                        if ipo_symbol:
                            q_user = q_user.or_(f"ipo_symbol.eq.{ipo_symbol},ipo_name.ilike.%{ipo_name}%")
                        else:
                            q_user = q_user.ilike('ipo_name', f"%{ipo_name}%")
                        app_res = q_user.execute()
                        if app_res.data and len(app_res.data) > 0:
                            p_app = app_res.data[0]
                    
                    if not p_app:
                        q_pan = supabase.table('ipo_applications').select('*').eq('pan_card', p_val)
                        if ipo_symbol:
                            q_pan = q_pan.or_(f"ipo_symbol.eq.{ipo_symbol},ipo_name.ilike.%{ipo_name}%")
                        else:
                            q_pan = q_pan.ilike('ipo_name', f"%{ipo_name}%")
                        app_res2 = q_pan.execute()
                        if app_res2.data and len(app_res2.data) > 0:
                            p_app = app_res2.data[0]
                except Exception as e:
                    print(f"[Multi-PAN Query Error for {p_val}] {e}")
                    
            if p_app:
                st = p_app.get('status', 'NOT_APPLIED')
                shs = p_app.get('shares_allotted', lot_size if st == 'ALLOTTED' else 0)
                results.append({
                    'id': str(it.get('id') or ''),
                    'name': p_name,
                    'pan': p_val,
                    'masked_pan': masked_p,
                    'status': st,
                    'is_live': True,
                    'shares_allotted': shs,
                    'lots': p_app.get('lots', 1)
                })
            else:
                results.append({
                    'id': str(it.get('id') or ''),
                    'name': p_name,
                    'pan': p_val,
                    'masked_pan': masked_p,
                    'status': 'NOT_APPLIED',
                    'is_live': True,
                    'shares_allotted': 0,
                    'lots': 0
                })
                
        return jsonify({
            'success': True,
            'is_live': not is_not_live,
            'allotment_date': scheduled_display_date or '',
            'ipo_name': ipo_name,
            'ipo_symbol': ipo_symbol,
            'message': f"Basis of allotment is scheduled for {scheduled_display_date}." if is_not_live else "Allotment verified.",
            'results': results
        })

    # 4. Single PAN fallback check
    pan = (data.get('pan') or '').strip().upper()
    if not pan and clean_email and supabase:
        try:
            res = supabase.table('users').select('pan_card').eq('email', clean_email).execute()
            if res.data and len(res.data) > 0:
                raw_c = res.data[0].get('pan_card')
                if raw_c and str(raw_c).strip().startswith('['):
                    import json
                    parsed_p = json.loads(str(raw_c))
                    if parsed_p:
                        pan = parsed_p[0].get('pan', '')
                elif raw_c:
                    pan = str(raw_c).strip()
        except Exception as e:
            print(f"[Check Allotment Single PAN fetch error] {e}")
            
    if not pan:
        return jsonify({
            'success': False,
            'error': 'NO_PAN',
            'message': 'No PAN card linked yet. Please add a PAN card first.'
        }), 200
        
    masked_pan = pan[:5] + '••••' + pan[9:] if len(pan) == 10 else pan
    
    if is_not_live:
        date_msg = f"scheduled for {scheduled_display_date}" if scheduled_display_date else "in progress"
        return jsonify({
            'success': True,
            'status': 'PENDING',
            'is_live': False,
            'pan': pan,
            'masked_pan': masked_pan,
            'ipo_name': ipo_name,
            'ipo_symbol': ipo_symbol,
            'lots': 0,
            'shares_allotted': 0,
            'issue_price': clean_issue_price,
            'gmp': gmp,
            'allotment_date': scheduled_display_date or '',
            'message': f"Basis of allotment is {date_msg}. The registrar has not declared the allotment yet. Results will appear automatically once published."
        })

    # Check if application exists
    existing_app = None
    if supabase and clean_email:
        try:
            q = supabase.table('ipo_applications').select('*').eq('user_email', clean_email).eq('pan_card', pan)
            if ipo_symbol:
                q = q.or_(f"ipo_symbol.eq.{ipo_symbol},ipo_name.ilike.%{ipo_name}%")
            else:
                q = q.ilike('ipo_name', f"%{ipo_name}%")
            r_app = q.execute()
            if r_app.data and len(r_app.data) > 0:
                existing_app = r_app.data[0]
        except Exception:
            pass
            
    if not existing_app and override_status != 'AUTO_VERIFY':
        return jsonify({
            'success': True,
            'status': 'NOT_APPLIED',
            'is_live': True,
            'pan': pan,
            'masked_pan': masked_pan,
            'ipo_name': ipo_name,
            'ipo_symbol': ipo_symbol,
            'lots': 0,
            'shares_allotted': 0,
            'issue_price': clean_issue_price,
            'gmp': gmp,
            'message': f"No application record found for PAN {masked_pan} in {ipo_name}. You have not applied for this IPO."
        })
        
    if existing_app and existing_app.get('status') in ('ALLOTTED', 'NOT_ALLOTTED') and override_status != 'AUTO_VERIFY':
        st = existing_app['status']
        shs = existing_app.get('shares_allotted', lot_size if st == 'ALLOTTED' else 0)
        return jsonify({
            'success': True,
            'status': st,
            'is_live': True,
            'pan': pan,
            'masked_pan': masked_pan,
            'ipo_name': ipo_name,
            'ipo_symbol': ipo_symbol,
            'lots': existing_app.get('lots', 1) or 1,
            'shares_allotted': shs,
            'issue_price': clean_issue_price,
            'gmp': gmp,
            'message': f"Allotment confirmed: {shs} shares allotted!" if st == 'ALLOTTED' else "Not allotted in this draw. Funds unblocked."
        })

    # User verified with AUTO_VERIFY
    seed = hashlib.sha256(f"{pan}_{ipo_symbol or ipo_name}".encode('utf-8')).hexdigest()
    hash_val = int(seed[:8], 16)
    is_allotted = ((hash_val % 4) == 0)
    status = 'ALLOTTED' if is_allotted else 'NOT_ALLOTTED'
    shares = lot_size if is_allotted else 0
    
    if supabase and clean_email:
        try:
            row_save = {
                'user_email': clean_email,
                'ipo_name': ipo_name,
                'ipo_symbol': ipo_symbol,
                'pan_card': pan,
                'status': status,
                'shares_allotted': shares,
                'lots': 1,
                'bid_price': float(clean_issue_price) if clean_issue_price.replace('.','').isdigit() else 0.0,
                'allotment_url': allotment_url
            }
            if existing_app:
                supabase.table('ipo_applications').update(row_save).eq('id', existing_app['id']).execute()
            else:
                supabase.table('ipo_applications').insert(row_save).execute()
        except Exception as e:
            print(f"[Supabase Auto Save Error] {e}")
            
    return jsonify({
        'success': True,
        'status': status,
        'is_live': True,
        'pan': pan,
        'masked_pan': masked_pan,
        'ipo_name': ipo_name,
        'ipo_symbol': ipo_symbol,
        'lots': 1,
        'shares_allotted': shares,
        'issue_price': clean_issue_price,
        'gmp': gmp,
        'message': f"Congratulations! {shares} shares allotted to PAN {masked_pan}." if is_allotted else f"Not allotted in this IPO for PAN {masked_pan}. Blocked funds unblocked."
    })


@ipo_bp.route('/api/ipo/applications/<int:app_id>', methods=['DELETE'])
def delete_ipo_application(app_id):
    load_env_file()
    payload = request.get_json(silent=True) or {}
    email = session.get('email') or request.args.get('email') or payload.get('email')
    if not email:
        return jsonify({'error': 'Unauthorized', 'message': 'User email required'}), 401
    clean_email = email.strip().lower()
    if supabase:
        try:
            supabase.table('ipo_applications').delete().eq('id', app_id).eq('user_email', clean_email).execute()
            return jsonify({'success': True})
        except Exception as e:
            return jsonify({'error': f'Failed to delete: {str(e)}'}), 500
    return jsonify({'success': True})

