# DeepSeek Harness Docker —— 便捷命令
# 使用 .RECIPEPREFIX，避免 Makefile 对 tab 的依赖。
.RECIPEPREFIX = >

IMAGE ?= ghcr.io/735876214/deepseek-harness-docker
TAG ?= latest
DSH_VERSION ?= 0.2.2-alpha.3

.PHONY: help run stop build push track publish clean

help:
> @echo "Targets:"
> @echo "  run      - docker compose up -d"
> @echo "  stop     - docker compose down"
> @echo "  build    - 本地构建镜像 (--build-arg DSH_VERSION)"
> @echo "  push     - 构建并推送镜像"
> @echo "  track    - 运行上游跟踪脚本，检查是否有新版本"
> @echo "  publish  - 构建并推送当前 VERSION 对应镜像"
> @echo "  clean    - 停止并删除数据卷"

run:
> docker compose up -d

stop:
> docker compose down

build:
> docker build --platform linux/amd64 --build-arg DSH_VERSION=$(DSH_VERSION) -t $(IMAGE):$(TAG) .

push: build
> docker push $(IMAGE):$(TAG)

track:
> bash scripts/track-upstream.sh

publish: build
> docker push $(IMAGE):$(TAG)

clean:
> docker compose down -v
