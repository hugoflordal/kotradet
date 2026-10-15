.PHONY: web

# Serve the web version locally.
web:
	@echo "Öppna http://localhost:8001/"
	cd web && python3 -m http.server 8001
