VERSION ?= 0.1.0

.PHONY: frontend build run app clean

frontend:
	cd frontend && (test -d node_modules || npm ci) && sh build.sh

build: frontend
	go build -o bin/gocpy-ide .

run: build
	./bin/gocpy-ide

app:
	VERSION=$(VERSION) sh packaging/make-app.sh

clean:
	rm -rf bin dist
