# 스마트스토어 재고·신상품 감시 (TypeScript)

`smartstore_stock.py` 를 TypeScript 로 옮긴 버전입니다. 같은 `../smartstore_config.json` 과 `../naver_session.json` 을 그대로 읽고, 기능도 같습니다 (상품 재고 조회·감시, 카테고리 신상품 감시, 디스코드 알림, 요청률 안전장치).

> 같은 폴더에 **G마켓 바로구매**(`src/gmarket/`, `.\gm`)가 같이 산다 — [README-gmarket.md](README-gmarket.md).

## 준비

```bash
cd ts
npm install
```

브라우저는 Python 쪽에 이미 설치된 Chromium 을 그대로 씁니다. 로그인 세션도 같은 파일이라 **이미 `--login` 을 했다면 다시 할 필요 없습니다.** 처음이면:

```bash
npm start -- --login
```

## 실행

```bash
npm start -- https://smartstore.naver.com/pokemontcg/products/13425750814
```

```bash
npm start -- --rate
```

```bash
npm start -- --once --dry-run
```

```bash
npm start -- --watch
```

루트의 `run-smartstore-ts.bat` 을 더블클릭해도 됩니다. 전체 옵션은 `.\ss --help` (파워셸에서 `npm start -- --help` 는 npm 도움말이 뜹니다).

| 스크립트 | 설명 |
|---|---|
| `npm start` | 실행 (tsx, 빌드 불필요) |
| `npm run watch` | `--watch` 단축 |
| `npm run typecheck` | 타입 검사 (`strict` + `noUncheckedIndexedAccess`) |
| `npm run build` | `dist/` 로 컴파일 |

## 바로구매 (lotte-test 와 같은 흐름)

`aio/node/src/lotte-test` 처럼, 지켜보다가 열리는 순간 산다.

```
지켜보기 → 품절→구매가능 감지 → 창을 띄워 구매하기 → 구매 레이어(수량·바로구매)
        → 네이버페이 주문서 → [결제하기] → 인증 화면 → [간편결제 비밀번호]
        → 마지막 확인 [결제내용에 동의 → 결제] → 결제 완료 알림
```

**마지막 확인**은 익스텐션(`aio/extension`)의 "네이버페이 마지막 확인 (비밀번호 뒤)" 흐름과 같은
것이다(원본은 bnkr-test `NPAY_FINISH`). 네이버페이는 비밀번호 뒤에 "결제내용에 동의하시면 '결제'
버튼을 눌러 구매완료합니다." 체크와 `결제` 버튼을 한 번 더 세운다.

- 비밀번호를 넣자마자 8초 동안 촘촘히 보고, 못 끝내면 결제 완료를 지켜보는 동안 0.5초마다 계속 본다.
  비밀번호를 사람이 넣는 판이어도 넣고 나면 눌러 준다.
- **순서대로만** 누른다. 동의 체크가 정말 켜진 것을 보고서야 `결제` 를 찾는다.
- `결제` 는 **글자가 딱 "결제" 인 버튼만** 누른다. 2026-08-17 bnkr 판에서 느슨하게 찾다가 단계
  목록(`ol.steps`)을 누른 적이 있다. 버튼 글자가 다르면 누르지 않고 남겨 둔다 — 사람이 누르면 된다.
- 주소에 `://pay.naver.com` 이 든 화면에서만 본다 (주문서 `orders.pay.naver.com` 은 빠진다).
- 끄려면 `"finish_steps": []` — 그 화면에서 멈춘다.

**`buy.targets` 가 비어 있으면 예전처럼 알림만 보낸다.** 설정은 `smartstore_config.json` 의
`"buy"` 칸 하나에 모았다. 파이썬 판과 같은 파일이라 맨 위에 흩지 않았다 — 파이썬 판은
이 칸을 모르고 지나간다.

```json
"buy": {
  "targets": [
    "https://smartstore.naver.com/moncolle_korea/products/13763561200",
    { "url": "https://brand.naver.com/pokemon/products/12714734588", "ea": 2, "option": "A세트", "max_price": 30000 }
  ],
  "order_action": "submit",
  "buy_on_restock_only": true,
  "max_buys_per_run": 1,
  "cooldown_minutes": 30,
  "pg_password": "",
  "finish_steps": ["결제내용에 동의", "결제"]
}
```

살 상품은 `products` 에 따로 적지 않아도 감시 목록에 들어간다. 로그인은 감시와 같은
`naver_session.json` 을 쓴다 — 쿠키를 따로 붙여 넣을 일이 없다.

**파워셸에서는 `.\ss` 로 부른다** (`ts` 폴더에서). 윈도우 파워셸은 `npm start -- --pin 123456` 의
`--` 를 지워서, npm 이 `--pin` 을 제 옵션으로 가져가고 프로그램에는 `123456` 만 온다
("지원하지 않는 URL 형식입니다"). `ss.cmd` 는 npm 을 거치지 않아 옵션이 그대로 간다.
npm 으로 불러도 가져간 옵션은 되찾지만, 값을 받는 옵션(`--interval 5`·`--state 경로`)과
`--help` 는 되찾을 수 없어 `.\ss` 로 부르라고 알려 준다.

| | |
|---|---|
| `.\ss --whoami` | 로그인 세션이 살아 있는지 |
| `.\ss --add URL …` | 살 상품을 `buy.targets` 에 넣는다 |
| `.\ss --watch` | 지켜보다가 열리면 산다 |
| `.\ss --link` | 클립보드의 상품 주소 하나만 이번 실행의 대상으로 삼고 곧장 감시 |
| `.\ss --buy URL` | 지금 바로 산다 (품절이면 창을 안 띄운다) |
| `.\ss --dump-pay URL` | `--buy` 와 같되 결제하기 뒤 화면을 `smartstore-ts-pg-dump.txt` 에 받아 적는다 |
| `--action open\|submit` | 이번만 어디까지 갈지 |
| `--no-buy` | 이번 실행은 사지 않고 알림만 |
| `--reset` | 산 기록(상태 파일의 `_buy`)을 지운다 |
| `--pin [비밀번호]` | 간편결제 비밀번호 저장 (값 없이 = 클립보드, `clear` = 지우기) |

**어디까지 가나 — `order_action`**

| | |
|---|---|
| `"submit"` (기본) | 결제하기를 누르고 **인증 화면에서 멈춘다.** 비밀번호는 사람이 넣는다 |
| `"submit"` + `pg_password` | 비밀번호 자판 → 마지막 확인까지 누른다 — **사람 손 없이 결제가 끝난다** |
| `"open"` | 주문서를 열어 두고 멈춘다 |

비밀번호는 로그·덤프에 남기지 않는다(자릿수만). 파일에 두기 싫으면 `NAVER_PG_PASSWORD`
환경변수로 넘긴다. 틀리면 다시 넣어 보지 않는다 — 몇 번 틀리면 잠긴다.

**품절→구매가능 으로 바뀌는 순간에만 산다** (`buy_on_restock_only`). 켤 때 이미 팔고 있던
상품은 사지 않고 `--buy` 주소를 알려 준다. 주문서에서 품절로 밀려나면(한발 늦음) 쉬지 않고
다음 재입고를 보고, 세 번 이어지면 `cooldown_minutes` 만큼 쉰다.

**창은 닫지 않는다.** 결제는 그 창에서 끝나므로, 감시가 멈춰도 구매 창이 열려 있으면 사람이
창을 닫을 때까지 프로그램이 기다린다 (Ctrl+C 를 누르면 창째로 끝난다). Playwright 가 띄운
브라우저는 프로그램과 함께 닫히기 때문이다.

감시 간격은 바뀌지 않는다. 아래의 요청률 안전장치가 그대로 걸린다 — 롯데온 판처럼 2초마다
보면 네이버는 로그인 세션째로 막는다.

### 어디까지 확인했나

- 확인함: 설정 읽기·쓰기(다른 칸 보존), 구매 판단(처음 본 판매중은 안 삼, 품절→판매에 삼,
  옵션 품절·가격 상한), 실제 상품으로 `--link --once --dry-run`, 품절 상품 `--buy` 거절,
  `--whoami`, 페이지 조각(글자로 버튼 찾기·레이어·숫자 롤러 결제 버튼·alert·받아적기)은 가짜 페이지로.
  마지막 확인도 가짜 `pay.naver.com` 화면으로: 숨은 체크박스를 라벨로 켜고 `결제`, 이미 체크된 경우,
  동의 항목이 없으면 `결제` 도 안 누름, `결제하기` 는 안 누름, 주문서에서는 안 누름, 단계 목록·
  `결제수단 변경` 링크는 안 누름, 늦게 뜬 확인 화면을 기다렸다 누르고 완료까지 봄.
- **못 봄: 실제 주문서·결제하기·인증 자판을 이 판(Playwright)으로 끝까지 가 본 적이 없다.**
  글자·주소·버튼 모양은 셀레니움 판(`aio/node/src/naver`)이 실제로 가 본 것을 그대로 옮겼다.
  처음 한 번은 `.\ss --dump-pay URL --action open` 으로 주문서까지만 가 보고,
  그다음 `submit` 으로 가는 것을 권한다.

## Python 버전과 다른 점

**전 호스트를 브라우저로 읽습니다.** Python 은 brand.naver.com 을 `curl_cffi` (Chrome TLS 지문 흉내)로 읽어 브라우저 없이 통과했지만, Node 의 `fetch` 는 brand.naver.com 도 429 로 막힙니다. 지문을 흉내 낼 방법이 없어서 모든 조회가 Playwright 를 거칩니다. 감시 중에는 브라우저를 한 번 띄워 재사용하므로 체감 차이는 없고, `--once` 나 단건 조회는 Chromium 기동 시간(1~2초)이 더 듭니다.

**상태·로그 파일이 분리됩니다.** 같은 파일에 두 프로세스가 쓰면 서로 덮어쓰기 때문입니다.

| | Python | TypeScript |
|---|---|---|
| 상태 | `smartstore_state.json` | `smartstore_state.ts.json` |
| 로그 | `smartstore-stock.log` | `smartstore-ts.log` |

처음 실행하면 기준선을 새로 만들고 시작 요약이 한 번 갑니다 (신상품 알림은 가지 않습니다). 기존 기준선을 이어 가려면 `--state ../smartstore_state.json` 을 주세요. **단, 두 버전을 동시에 돌리지 마세요.** 같은 로그인 세션으로 요청이 합산되어 요청률이 두 배가 됩니다.

**결함 하나를 고쳤습니다.** 첫 회차가 차단되거나 Ctrl+C 로 끊기면 Python 버전은 "상품 0개" 인 빈 시작 요약을 보내고 '시작 알림 완료' 로 기록해 버립니다. TS 는 모든 대상이 확인된 뒤에만 요약을 보냅니다.

그 외에 Ctrl+C 를 누르면 백오프 대기(최대 1시간)를 즉시 깨우고 상태를 저장한 뒤 종료하고, 상태 파일은 임시 파일에 쓴 뒤 바꿔치기해서 도중에 죽어도 깨지지 않습니다.

## 문제 해결

### `Executable doesn't exist at ...ms-playwright\chromium_headless_shell-...`

Playwright 가 기대하는 버전의 Chromium 이 이 PC 에 없다는 뜻입니다. **설치하지 않아도 됩니다.** 번들 Chromium 이 없으면 자동으로 **설치된 Google Chrome → Microsoft Edge** 순으로 대신 실행합니다 (Windows 11 에는 Edge 가 항상 있습니다). 이때 로그에 이렇게 한 줄 남습니다.

```
[WARNING] 번들 Chromium 을 찾지 못해 설치된 Google Chrome 로 실행합니다.
```

셋 다 실패하면 실패 사유를 나열하고 종료합니다. 이 오류는 감시를 시작하기 전에 한 번만 나고 바로 종료합니다.

번들 Chromium 을 굳이 받고 싶다면 `ts` 폴더에서 `npx playwright install chromium` 을 실행하세요. 이미 있으면 아무것도 받지 않습니다. 다만 `cdn.playwright.dev` 로 나가는 연결이 막힌 네트워크에서는 `Request ... timed out after 30000ms` 로 실패합니다. 그런 환경이면 위의 자동 대체가 유일한 해결책입니다.

버전이 어긋나지 않도록 Playwright 는 `1.63.0` 으로 고정해 두었습니다.

## 검증 상태

- 오프라인 51개 항목 통과: URL 재작성, 상품 노드 탐색(네이버가 모양을 바꿔도 버팀), 옵션 파싱, 변화 판정, 요청률 계산(Python `--rate` 와 동일), 신상품 판정, 차단 백오프, 세션 만료, 브라우저 기동 실패, 빈 시작 요약 회귀
- **brand.naver.com 실제 조회 통과**: 상품 재고, 카테고리(`?cp=1` 자동 재작성), 변화 감지, 신상품 감지를 실제 데이터로 확인
- **smartstore.naver.com 은 이 PC 에서 실제 조회를 못 해 봤습니다.** 검증 시점에 Python 도구로도 같은 상품이 HTTP 429 였습니다. 코드 문제가 아니라 IP/세션에 걸린 차단이며, 429 를 차단으로 분류해 백오프하는 경로만 실제로 확인됐습니다.
- 디스코드 전송은 실제로 보내 보지 않았습니다 (전송 실패 경로만 확인). 첫 실행 전에 `npm start -- --test` 로 확인하세요.
