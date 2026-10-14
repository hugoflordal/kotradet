import pdfplumber
from graphviz import Digraph
from collections import defaultdict
import datetime
import re
import os
import glob
import sys
import json

# The script folder holds the HTML template; the data folder holds the CDB PDFs,
# notes.json, config.json and the generated output. Data folder = first argument,
# or the current directory.
script_dir = os.path.dirname(os.path.abspath(__file__))
data_dir = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
os.chdir(data_dir)

# Farm-specific settings live in config.json next to the PDFs (see config.example.json):
#   summer_pasture: production site number where bulls and cows graze together
#   eco_date:       date the herd's production became organic (YYYY-MM-DD)
config = {}
if os.path.exists("config.json"):
    with open("config.json", encoding="utf-8") as f:
        config = json.load(f)
SUMMER_PASTURE = config.get("summer_pasture")
ECO_DATE = (datetime.datetime.strptime(config["eco_date"], "%Y-%m-%d").date()
            if config.get("eco_date") else None)

# --- Parse one PDF file and return (animals, date_from_filename) ---
def parse_pdf(filename):
    animals = []
    # Extract date from filename (e.g. Djurinnehav_..._20250710.pdf)
    date_match = re.search(r'(\d{8})\.pdf$', filename)
    pdf_date = datetime.datetime.strptime(date_match.group(1), "%Y%m%d").date() if date_match else None

    with pdfplumber.open(filename) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if not text:
                continue
            lines = text.split("\n")
            for line in lines:
                # Match lines that include animal ID, birth, sex, breed, optional mother,
                # and optional "Tillfälligt ute på" location code (6 digits directly after mother)
                match = re.match(
                    r"^\d+\s(SE\s\d{6}\s\d{4}\s\d)\s(\d{4}-\d{2}-\d{2})\s([KT])\s(\d{2})"
                    r"(?:\s(SE\s\d{6}\s\d{4}\s\d))?"
                    r"(?:\s(\d{6})(?!\d))?"
                    r"(?:\s(\d{4}-\d{2}-\d{2}))?"
                    r"(?:\s(\d{6}))?",
                    line
                )
                if match:
                    full_id = match.group(1).replace(" ", "")
                    birth = match.group(2)
                    sex = match.group(3)
                    breed = match.group(4)
                    mother = match.group(5)
                    mother = mother.replace(" ", "") if mother else None
                    location = match.group(6)  # "Tillfälligt ute på" code, or None
                    purchase_date = match.group(7)  # Köpdatum, or None
                    purchase_from = match.group(8)  # Från SE-nr, or None

                    animals.append({
                        "id": full_id,
                        "birth": birth,
                        "sex": sex,
                        "breed": breed,
                        "mother": mother,
                        "location": location,
                        "purchase_date": purchase_date,
                        "purchase_from": purchase_from,
                    })
    return animals, pdf_date


# --- Build genealogy graph ---
def build_graph(all_data):
    # Sort by date (each element = (animals, date))
    all_data.sort(key=lambda x: x[1])
    all_animals_by_date = {d: set(a["id"] for a in animals) for animals, d in all_data}

    # Combine all animals (latest info for duplicates, but preserve purchase_date)
    animals = {}
    for animals_list, d in all_data:
        for a in animals_list:
            prev = animals.get(a["id"])
            if prev and prev.get("purchase_date") and not a.get("purchase_date"):
                a["purchase_date"] = prev["purchase_date"]
                if prev.get("purchase_from") and not a.get("purchase_from"):
                    a["purchase_from"] = prev["purchase_from"]
            animals[a["id"]] = a

    # Determine which animals disappeared later
    removed_ids = set()
    dates = sorted(all_animals_by_date.keys())
    for i in range(len(dates) - 1):
        disappeared = all_animals_by_date[dates[i]] - all_animals_by_date[dates[i + 1]]
        removed_ids.update(disappeared)

    # --- Calf birth dates per mother (used for failed-to-calve check) ---
    from dateutil.relativedelta import relativedelta as rdelta
    calf_births_by_mother = defaultdict(list)
    for a in animals.values():
        if a["mother"]:
            calf_births_by_mother[a["mother"]].append(
                datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date()
            )

    # --- Determine "betäckta" (served) females ---
    # A female counts as served if, in any PDF snapshot, she was at the summer pasture,
    # was >= 14 months old, AND a bull >= 6 months old was also there in that
    # same snapshot.  She remains served until she calves after that event.
    today = datetime.date.today()
    served_ids = set()
    # served_event_dates[animal_id] = list of PDF dates where coverage was recorded
    served_event_dates = defaultdict(list)
    for animals_list, pdf_date in all_data:
        if not SUMMER_PASTURE:
            break
        at_loc = [a for a in animals_list if a.get("location") == SUMMER_PASTURE]
        qualifying_bulls = [
            a["id"] for a in at_loc
            if a["sex"] == "T"
            and (
                (pdf_date.year - datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date().year) * 12
                + (pdf_date.month - datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date().month)
            ) >= 6
        ]
        if qualifying_bulls:
            for a in at_loc:
                if a["sex"] == "K":
                    born = datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date()
                    age_m = (pdf_date.year - born.year) * 12 + (pdf_date.month - born.month)
                    if age_m >= 14:
                        served_event_dates[a["id"]].append(pdf_date)
                        served_ids.add(a["id"])

    # --- Remove from "betäckta" if the animal has calved after its last covering ---
    for aid in list(served_ids):
        calves = calf_births_by_mother.get(aid, [])
        event_dates = served_event_dates.get(aid, [])
        if event_dates and any(c > max(event_dates) for c in calves):
            served_ids.discard(aid)

    # --- Remove from "betäckta" if the animal has been sold or euthanized ---
    served_ids -= removed_ids

    # --- Determine "borde kalvat" (failed to calve) ---
    # Based on the most recent covering event without a subsequent calf.
    # 10-11 months: failed (✗).  >11 months: expired (remove served + failed).
    failed_ids = set()
    expired_ids = set()
    for aid, event_dates in served_event_dates.items():
        # Find the latest event that has no calf born after it
        calves = calf_births_by_mother.get(aid, [])
        latest_uncalved = None
        for ed in sorted(event_dates, reverse=True):
            if not any(c > ed for c in calves):
                latest_uncalved = ed
                break
        if latest_uncalved is None:
            continue
        months_elapsed = (today.year - latest_uncalved.year) * 12 + (today.month - latest_uncalved.month)
        if months_elapsed >= 11:
            expired_ids.add(aid)
        elif months_elapsed >= 10:
            failed_ids.add(aid)

    # Remove expired animals from served (no longer betäckt or failed)
    served_ids -= expired_ids

    # --- Determine ecological conversion status ---
    # Production became ecological on ECO_DATE (from config.json).
    # Animals born after that date are automatically ecological.
    # Animals born on or before: conversion period = max(12 months, 3/4 of age at conversion start).
    # Purchased animals: conversion date is their purchase date instead.
    eco_date = ECO_DATE
    non_eco_ids = set()
    for a in (animals.values() if eco_date else []):
        birth_date = datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date()
        conv_date = (datetime.datetime.strptime(a["purchase_date"], "%Y-%m-%d").date()
                     if a.get("purchase_date") else eco_date)
        if birth_date > conv_date:
            continue  # born after conversion → ecological
        age_at_conv_days = (conv_date - birth_date).days
        time_in_organic = (today - conv_date).days
        min_12_months = 365
        required = max(min_12_months, age_at_conv_days * 3 / 4)
        if time_in_organic < required:
            non_eco_ids.add(a["id"])
    non_eco_ids -= removed_ids  # don't flag removed animals

    # Group animals by birth year
    by_year = defaultdict(list)
    all_ids = set(animals.keys())
    for a in animals.values():
        a["year"] = datetime.datetime.strptime(a["birth"], "%Y-%m-%d").year
        a["short_id"] = a["id"][-5:-1] + "-" + a["id"][-1]
        by_year[a["year"]].append(a)

    # Use the last PDF date as "current date" for age calculations
    latest_date = max(dates)
    latest_date = datetime.date.today()
    
    dot = Digraph(comment="Cattle Genealogy", format='png')
    dot.attr(rankdir='TB')
    dot.attr(labelloc='t')    # place label at top
    dot.attr(labeljust='l')   # left

    sorted_years = sorted(by_year.keys())
    dummy_nodes = []

    for year in sorted_years:
        dummy_name = f'dummy_{year}'
        dummy_nodes.append(dummy_name)
        dot.node(dummy_name, '', shape='point', width='0.01', height='0.01', style='invisible')

        with dot.subgraph() as year_group:
            year_group.attr(rank='same')
            year_group.node(dummy_name)

            for a in by_year[year]:
                birth_date = datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date()
                rd = rdelta(latest_date, birth_date)
                age_months = rd.years * 12 + rd.months

                #print(a["id"] +  " " + str(age_months))
                #birth_date = datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date()
                #age_months = (latest_date.year - birth_date.year) * 12 + (latest_date.month - birth_date.month)

                # Determine color based on sex and age
                if a["sex"] == "K":
                    color = 'lightskyblue' if age_months >= 14 else 'aliceblue'
                else:  # "T"
                    color = 'lightpink' if age_months >= 6 else 'mistyrose'

                style = 'filled'

                # Determine age label (years or months)
                if age_months < 24:
                    age_str = f"{age_months}m"
                else:
                    age_years = age_months // 12
                    age_str = f"{age_years}y"

                # Create node label: short_id + age + birth date (+ x if failed to calve)
                failed_marker = " x" if a["id"] in failed_ids else ""
                label = f'{a["short_id"]} {age_str}{failed_marker}\\n{a["birth"]}'

                # Use box3d for served animals, box for all others
                shape = 'note' if a["id"] in served_ids else 'box'

                # Cross out if missing in later PDF
                if a["id"] in removed_ids:
                    style = 'filled,dashed'
                    label = f'<<s>{a["short_id"]} {age_str}{failed_marker}<br/>{a["birth"]}</s>>'
                    if a["sex"] == "K":
                        color = 'aliceblue'
                    else:  # "T"
                        color = 'mistyrose'
                year_group.node(a["id"], label, fontname='Helvetica-Bold', style=style, fillcolor=color, shape=shape)

    # Force chronological layout
    for i in range(len(dummy_nodes) - 1):
        dot.edge(dummy_nodes[i], dummy_nodes[i + 1], style='invisible', weight='100')

    # Mother → calf edges
    for a in animals.values():
        if a["mother"] and a["mother"] in all_ids:
            dot.edge(a["mother"], a["id"])

    # --- Summary of living animals ---
    living = {aid: a for aid, a in animals.items() if aid not in removed_ids}
    mothers = {a["mother"] for a in animals.values() if a["mother"]}
    bulls   = sum(1 for a in living.values() if a["sex"] == "T")
    cows    = sum(1 for a in living.values() if a["sex"] == "K" and a["id"] in mothers)
    heifers = sum(1 for a in living.values() if a["sex"] == "K" and a["id"] not in mothers)
    served = sum(1 for a in living.values() if a["id"] in served_ids)
    summary = {"tjurar": bulls, "kor": cows, "kvigor": heifers, "betäckta": served}

    # Append summary to graph label
    total = bulls + cows + heifers
    summary_line = f"Tjurar: {bulls}   Kor: {cows}   Kvigor: {heifers}   Betäckta: {served}   Totalt: {total}"
    dot.attr(label=f"Koträd {datetime.date.today().strftime('%Y-%m-%d')}\n{summary_line}")

    return dot, summary, removed_ids, served_ids, failed_ids, non_eco_ids


def build_html(all_data, dot_graph, summary_data, removed_ids, served_ids, failed_ids, non_eco_ids):
    """Build an interactive HTML page using Graphviz positions."""
    from dateutil.relativedelta import relativedelta as rdelta
    import subprocess

    all_data.sort(key=lambda x: x[1])

    # Combine all animals
    animals = {}
    for animals_list, d in all_data:
        for a in animals_list:
            animals[a["id"]] = a

    today = datetime.date.today()
    mothers_set = {a["mother"] for a in animals.values() if a["mother"]}
    living = {aid: a for aid, a in animals.items() if aid not in removed_ids}
    bulls = sum(1 for a in living.values() if a["sex"] == "T")
    cows = sum(1 for a in living.values() if a["sex"] == "K" and a["id"] in mothers_set)
    heifers = sum(1 for a in living.values() if a["sex"] == "K" and a["id"] not in mothers_set)
    served_count = sum(1 for a in living.values() if a["id"] in served_ids)

    # Get positions from Graphviz by rendering to plain format
    plain = dot_graph.pipe(format='plain').decode('utf-8')
    positions = {}
    for line in plain.splitlines():
        parts = line.split()
        if parts[0] == 'node':
            node_id = parts[1]
            x = float(parts[2]) * 96  # convert inches to pixels
            y = float(parts[3]) * 96
            positions[node_id] = {"x": x, "y": y}

    # Fetch name days for all unique birth dates
    import urllib.request
    unique_dates = set(a["birth"] for a in animals.values())
    namedays = {}
    for d in unique_dates:
        try:
            url = f"https://api.dryg.net/dagar/v2.1/{d.replace('-', '/')}"
            with urllib.request.urlopen(url, timeout=5) as resp:
                nd = json.loads(resp.read().decode())
                names = nd.get("dagar", [{}])[0].get("namnsdag", [])
                if names:
                    namedays[d] = names
        except Exception:
            pass

    min_year = 9999
    animal_list = []
    for a in animals.values():
        birth_date = datetime.datetime.strptime(a["birth"], "%Y-%m-%d").date()
        rd = rdelta(today, birth_date)
        age_months = rd.years * 12 + rd.months
        year = birth_date.year
        if year < min_year:
            min_year = year
        short_id = a["id"][-5:-1] + "-" + a["id"][-1]
        if age_months < 24:
            age_str = f"{age_months}m"
        else:
            age_str = f"{age_months // 12}y"

        pos = positions.get(a["id"], {"x": 0, "y": 0})
        animal_list.append({
            "id": a["id"],
            "short_id": short_id,
            "birth": a["birth"],
            "year": year,
            "sex": a["sex"],
            "breed": a["breed"],
            "mother": a["mother"],
            "age_months": age_months,
            "age_str": age_str,
            "removed": a["id"] in removed_ids,
            "served": a["id"] in served_ids,
            "failed": a["id"] in failed_ids,
            "conventional": a["id"] in non_eco_ids,
            "nameday": namedays.get(a["birth"], []),
            "purchase_date": a.get("purchase_date"),
            "purchase_from": a.get("purchase_from"),
            "x": pos["x"],
            "y": pos["y"],
        })

    edges = []
    all_ids = set(animals.keys())
    for a in animals.values():
        if a["mother"] and a["mother"] in all_ids:
            edges.append({"from": a["mother"], "to": a["id"]})

    data = {
        "animals": animal_list,
        "edges": edges,
        "min_year": min_year,
        "date": today.strftime("%Y-%m-%d"),
        "summary": {
            "tjurar": bulls,
            "kor": cows,
            "kvigor": heifers,
            "betackta": served_count,
            "totalt": bulls + cows + heifers,
        },
    }

    # Read notes.json if it exists
    notes_path = os.path.join(data_dir, "notes.json")
    notes = {}
    if os.path.exists(notes_path):
        with open(notes_path, "r", encoding="utf-8") as f:
            notes = json.load(f)

    # Read HTML template and inject data
    html_template = os.path.join(script_dir, "cattle_genealogy.html")
    with open(html_template, "r", encoding="utf-8") as f:
        html = f.read()

    html = html.replace("/*DATA_JSON*/null", json.dumps(data, ensure_ascii=False))
    html = html.replace("/*NOTES_JSON*/null", json.dumps(notes, ensure_ascii=False))

    output_path = os.path.join(data_dir, "cattle_genealogy_interactive.html")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    return output_path


def main():
    # Find all PDFs in script folder
    pdf_files = sorted(glob.glob("*.pdf"))
    all_data = []

    for pdf_file in pdf_files:
        animals, date = parse_pdf(pdf_file)
        if date:
            all_data.append((animals, date))
            print(f"Read {len(animals)} animals from {pdf_file} ({date})")

    if not all_data:
        print("No valid PDF files found.")
    else:
        graph, summary, removed_ids, served_ids, failed_ids, non_eco_ids = build_graph(all_data)
        graph.render('cattle_genealogy', view=False)

        html_path = build_html(all_data, graph, summary, removed_ids, served_ids, failed_ids, non_eco_ids)

        print(f"\nKoträd {datetime.date.today().strftime('%Y-%m-%d')}")
        print(f"  Tjurar:   {summary['tjurar']}")
        print(f"  Kor:      {summary['kor']}")
        print(f"  Kvigor:   {summary['kvigor']}")
        print(f"  Betäckta: {summary['betäckta']}")
        print(f"  Totalt:   {summary['tjurar'] + summary['kor'] + summary['kvigor']}")
        print(f"\n  Interaktiv sida: {html_path}")


if __name__ == "__main__":
    main()
