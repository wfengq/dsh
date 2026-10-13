# Changesets

每个对外可见的改动都附带一个 changeset 文件，说明影响哪些包、属于 major / minor / patch 中的哪一级：

```sh
pnpm changeset
```

版本号和 CHANGELOG 由 `pnpm changeset version` 统一生成。

预览版（`0.1.0-beta.0`，2026-10-13 发布；`0.1.0-beta.1`）的版本号直接写在各包的 `version` 里，不经 `changeset version` 提升：在 0.x 阶段，次版本号的提升会超出各包之间 `^0.1.0` 的依赖范围，changesets 会因此把依赖它的包连带升到主版本。各包的 `publishConfig.tag` 是 `beta`，所以发布不会落到 `latest` 标签上。

发布由仓库所有者在自己的机器上运行（需要先 `npm login`）：

```sh
pnpm install && pnpm run build && pnpm test
pnpm -r publish --access public --tag beta
```

`pnpm -r publish` 按依赖顺序发布五个包，并跳过 npm 上已经存在的版本。未经仓库所有者同意，不要运行发布命令。
