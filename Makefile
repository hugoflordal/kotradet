# DATA = folder with the CDB PDFs (Djurinnehav_*.pdf), notes.json and config.json.
DATA ?= .
VENV := /tmp/kotradet-venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
SCRIPT := $(abspath cdb.py)

.PHONY: run serve web clean
.DEFAULT_GOAL := run

$(VENV)/bin/activate:
	python3 -m venv $(VENV)
	$(PIP) install pdfplumber graphviz python-dateutil

run: $(VENV)/bin/activate
	$(PYTHON) $(SCRIPT) "$(DATA)"

serve: run
	@echo "Öppna http://$$(hostname -I | awk '{print $$1}'):8000/cattle_genealogy_interactive.html"
	cd "$(DATA)" && $(PYTHON) -m http.server 8000

web:
	@echo "Öppna http://localhost:8001/"
	cd web && python3 -m http.server 8001

clean:
	rm -rf $(VENV)
