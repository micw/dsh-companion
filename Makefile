.PHONY: build test vscode-package

build:
	pnpm run build

test:
	pnpm test

vscode-package:
	pnpm run vscode:package
