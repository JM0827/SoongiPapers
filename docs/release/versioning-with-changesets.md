# 버전 관리 자동화 방안 (SemVer + Changesets)

## 개요
- 모노레포(`server`, `web`, 공통 패키지 포함)는 패키지별로 버전을 따로 올릴 필요가 있음.
- 수동으로 `package.json`을 수정하거나 git 태그를 관리하면 작업 누락/충돌이 발생하기 쉬움.
- **Changesets** 도구를 도입하면 PR마다 변경 요약만 기록하고, 릴리스 시 자동으로 semver(`major.minor.patch`)에 맞춰 버전을 올리고 changelog를 생성할 수 있다.

## 목표
1. PR 단위로 변경 내용을 기록(Changeset) → 별도 브랜치로 누적.
2. 메인 브랜치에 릴리스 커밋을 만들 때 `changeset version`을 실행 → 각 패키지의 버전 증가 + CHANGELOG 자동 생성.
3. CI(GitHub Actions 등)를 통해 버전 bump, 태그 생성, 배포 자동화를 연동.

## 설치 & 초기화
```bash
npm install --save-dev @changesets/cli
npx changeset init
```

생성 파일: `.changeset/config.json`, `.changeset/README.md`

### config 기본 예시 (`.changeset/config.json`)
```json
{
  "$schema": "https://unpkg.com/@changesets/config@2.3.0/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "ORG/REPO" }],
  "commit": false,
  "linked": [],
  "fixed": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```
- `repo`는 GitHub 조직/저장소로 교체
- `commit: false` → version 단계에서 커밋은 수동 혹은 CI가 처리

## PR 워크플로우
1. 변경 PR에서 `npx changeset` 실행 → 변경 내용, 영향받는 패키지, 버전 종류(patch/minor/major)를 선택.
2. `.changeset/*.md` 파일이 생성되며 PR에 포함 → 리뷰어는 누락 여부 확인.
3. main 브랜치에는 아직 버전이 바뀌지 않음 (changeset 파일만 누적).

### changeset 예시 (`.changeset/bright-spiders-raise.md`)
```md
---
"project-t1-server": patch
"web": minor
---

서버에 JSON v2 파서 추가, 웹 하이라이트 업데이트
```

## 릴리스 단계
- main 브랜치에 릴리스 준비가 되면 `npx changeset version` 실행:
  - 각 패키지 `package.json` 버전이 semver 규칙에 맞춰 자동 증가
  - 각 패키지의 `CHANGELOG.md` 생성/갱신
  - `.changeset/*` 파일 제거
- 필요 시 `npx changeset publish`로 npm 배포

### CI(GitHub Actions) 연동
1. main에 변경이 머지되면 자동으로 `version` → `commit & tag` → `publish` 실행하는 Workflow 구성.
2. Changesets 공식 Action 활용 예시:
```yaml
name: Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org/
      - run: npm ci
      - uses: changesets/action@v1
        with:
          commit: "chore: release"
          title: "chore: release"
          publish: false # npm publish 필요하면 true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
- 이 Action은 changeset이 존재하면 자동으로 `version`, 커밋, 태그 생성.
- `publish: false` → 태그/커밋만 남기고 npm 배포는 하지 않음 (내부 repo에 적합).

## Changelog & 태그
- `changeset version`과정에서 `CHANGELOG.md` 자동 생성 → 릴리스 노트 작성 최소화.
- CI 또는 수동으로 `git tag vX.Y.Z` + `git push --tags` 수행.
- GitHub Release 템플릿으로 changelog 내용을 활용할 수 있음.

## 주의/운영 팁
- PR에 Changeset 미작성 시 린터/Action으로 경고 → `changeset status --since=origin/main` 활용.
- 패키지별로 버전 분리 필요 없다면 `group` 방식도 가능하지만, 현재는 서버/웹 각각 다르게 올라가야 함.
- .changeset 폴더를 커밋하지 않거나 PR 통합 전에 누락하면 자동 버전이 돌아가지 않으므로, 리뷰 템플릿에 체크항목 추가.

## TODO
- [ ] Changesets CLI 설치 및 초기 commit
- [ ] GitHub Actions Release Workflow 추가
- [ ] 기존 CHANGELOG 작성 규칙과 통합
- [ ] 초기 버전 기준 정리 (server 1.0.0, web 0.0.0 → 필요 시 align)

