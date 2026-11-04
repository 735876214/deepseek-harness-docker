# DeepSeek Harness Docker —— 便捷命令
# 使用 .RECIPEPREFIX，避免 Makefile 对 tab 的依赖。
.RECIPEPREFIX = >

IMAGE ?= ghcr.io/735876214/deepseek-harness-docker
TAG ?= latest
# 从版本真值文件读取，避免此处与 UPSTREAM_VERSION 漂移
DSH_VERSION ?= $(shell grep '^NPM_VERSION=' UPSTREAM_VERSION | cut -d= -f2-)

.PHONY: help run stop build push track publish version clean

help:
> @echo "Targets:"
> @echo "  run      - docker compose up -d"
> @echo "  stop     - docker compose down"
> @echo "  build    - 本地构建镜像 (--build-arg DSH_VERSION)"
> @echo "  push     - 构建并推送镜像"
> @echo "  track    - 运行上游跟踪脚本，检查是否有新版本"
> @echo "  publish  - 构建并推送当前 VERSION 对应镜像"
> @echo "  version  - 打印打包版本 / 上游版本 / 修订号 / 上游 commit"
> @echo "  clean    - 停止并删除数据卷"

run:
> docker compose up -d

stop:
> docker compose down

version:
> @echo "打包版本   : $$(cat VERSION)"
> @echo "上游版本   : $$(grep '^UPSTREAM_VERSION=' UPSTREAM_VERSION | cut -d= -f2-)"
> @echo "打包修订号 : r$$(cat PACKAGING_REVISION)"
> @echo "上游 commit: $$(grep '^UPSTREAM_COMMIT=' UPSTREAM_VERSION | cut -d= -f2-)"
> @echo "npm 版本   : $(DSH_VERSION)"

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
