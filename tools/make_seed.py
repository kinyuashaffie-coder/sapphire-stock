"""Build supabase/seed.sql from the Sapphire Excel workbook.

Usage: python tools/make_seed.py "path/to/workbook.xlsx" ADMIN_PASSWORD
Every sheet becomes a closed stock take; a new open stock take starts
with the last sheet's counts as opening stock.
"""
import datetime
import os
import re
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "supabase", "seed.sql")


def num(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None  # '#REF!' and similar


def clean(v):
    if v is None:
        return None
    s = re.sub(r"\s+", " ", str(v)).strip()
    return s or None


def read_workbook(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows, header = [], False
        for r in ws.iter_rows(min_row=1, max_col=12, values_only=True):
            r = list(r) + [None] * (12 - len(r))
            name = clean(r[0])
            if not header:
                header = bool(name and name.lower() == "product")
                continue
            if not name:
                if rows:
                    break  # totals row; expenses/till notes below are not stock
                continue
            rows.append({"name": name, "opening": num(r[1]) or 0.0, "purchases": num(r[2]) or 0.0,
                         "closing": num(r[3]) or 0.0, "category": clean(r[9]),
                         "buy": num(r[10]), "sell": num(r[11])})
        if rows:
            sheets.append({"name": ws.title.strip(), "rows": rows})
    return sheets


def q(v):
    if v is None:
        return "null"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(path, admin_pw):
    sheets = read_workbook(path)
    info, order = {}, []
    for sh in sheets:
        for row in sh["rows"]:
            k = row["name"].lower()
            if k not in info:
                info[k] = {"name": row["name"], "category": None, "buy": None, "sell": None}
                order.append(k)
            for f in ("category", "buy", "sell"):
                if row[f] is not None:
                    info[k][f] = row[f]
    pid = {k: i + 1 for i, k in enumerate(order)}

    out = ["-- Sapphire starting data, generated from the Excel workbook on "
           f"{datetime.date.today():%d %b %Y}.", ""]
    out.append("insert into public.products (id, name, category, sell) values")
    out.append(",\n".join(f"  ({pid[k]}, {q(info[k]['name'])}, {q(info[k]['category'] or 'Other')}, {q(info[k]['sell'])})"
                          for k in order) + ";")
    costs = [k for k in order if info[k]["buy"] is not None]
    out.append("insert into public.product_costs (product_id, buy) values")
    out.append(",\n".join(f"  ({pid[k]}, {q(info[k]['buy'])})" for k in costs) + ";")

    last = {}
    for n, sh in enumerate(sheets, start=1):
        out.append(f"\n-- stock take: {sh['name']}")
        out.append(f"insert into public.periods (id, name, status, closed_at, closed_by) "
                   f"values ({n}, {q(sh['name'])}, 'closed', now(), 'excel');")
        lines, lcosts, moves, seen = [], [], [], set()
        for row in sh["rows"]:
            k = row["name"].lower()
            if k in seen:
                continue  # duplicate row in the sheet: keep the first
            seen.add(k)
            sell = row["sell"] if row["sell"] is not None else info[k]["sell"]
            buy = row["buy"] if row["buy"] is not None else info[k]["buy"]
            lines.append(f"  ({n}, {pid[k]}, {q(row['opening'])}, {q(row['closing'])}, {q(sell)}, 'excel')")
            if buy is not None:
                lcosts.append(f"  ({n}, {pid[k]}, {q(buy)})")
            if row["purchases"] > 0:
                moves.append(f"  ({n}, {pid[k]}, 'in', {q(row['purchases'])}, 'from Excel', 'excel')")
            last[pid[k]] = row["closing"]
        out.append("insert into public.lines (period_id, product_id, opening, closing, sell, counted_by) values")
        out.append(",\n".join(lines) + ";")
        if lcosts:
            out.append("insert into public.line_costs (period_id, product_id, buy) values")
            out.append(",\n".join(lcosts) + ";")
        if moves:
            out.append("insert into public.movements (period_id, product_id, type, qty, note, created_by) values")
            out.append(",\n".join(moves) + ";")

    op = len(sheets) + 1
    out.append(f"\n-- the stock take you count next")
    out.append(f"insert into public.periods (id, name) values ({op}, "
               f"{q('Stock take from ' + format(datetime.date.today(), '%d %b %Y'))});")
    out.append("insert into public.lines (period_id, product_id, opening) values")
    out.append(",\n".join(f"  ({op}, {pid[k]}, {q(last.get(pid[k], 0.0))})" for k in order) + ";")

    out.append("\nselect setval(pg_get_serial_sequence('public.products', 'id'), (select max(id) from public.products));")
    out.append("select setval(pg_get_serial_sequence('public.periods', 'id'), (select max(id) from public.periods));")
    out.append("\n-- first admin account (must change password at first sign-in)")
    out.append(f"select public._create_user('admin', 'Administrator', {q(admin_pw)}, 'admin', public.allowed_perms());")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(f"wrote {OUT}: {len(order)} products, {len(sheets)} stock takes")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
