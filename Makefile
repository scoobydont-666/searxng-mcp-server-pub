SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
PYTHON ?= python3
HELM ?= helm
export HELM

.PHONY: check runtime iac iac-deps capacity render
check: runtime iac

runtime:
	npm run build
	$(PYTHON) scripts/test_with_valkey.py
	node --test tests/load-result.node.mjs

# Install the hash-locked validator set; PYTHON may point at a venv interpreter.
iac-deps:
	$(PYTHON) -m pip install --disable-pip-version-check --require-hashes -r requirements-iac.txt

iac:
	$(PYTHON) -m unittest discover -s tests/iac -p 'test_*.py' -v
	$(PYTHON) scripts/check_publication.py
	$(PYTHON) scripts/check_iac.py
	ansible-playbook -i localhost, ansible/bootstrap.yml --syntax-check
	bash -n scripts/build-image.sh

capacity:
	$(PYTHON) scripts/capacity.py

render:
	@test -n "$(VALUES)" || { echo 'Set VALUES to your environment values file' >&2; exit 2; }
	$(HELM) template searxng-platform charts/searxng-platform --namespace searxng -f "$(VALUES)"
