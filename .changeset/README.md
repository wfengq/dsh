# Changesets

每个对外可见的改动都附带一个 changeset 文件，说明影响哪些包、属于 major / minor / patch 中的哪一级：

```sh
pnpm changeset
```

版本号和 CHANGELOG 由 `pnpm changeset version` 统一生成。首个版本按现有的 0.1.0 发布，不做提升：在 0.x 阶段，次版本号的提升会超出各包之间 `^0.1.0` 的依赖范围，changesets 会因此把依赖它的包连带升到主版本。**目前尚未发布到 npm**，发布与否等全部功能完成后再决定；在那之前不要运行 `changeset version`、`changeset publish` 或 `npm publish`。
