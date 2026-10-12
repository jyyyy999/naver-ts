// 처음 받은 PC 에서 한 번: 설정 파일을 이 폴더 위(../)에 만든다.
// cli.ts 는 설정·세션·상태·로그를 저장소 밖 ../ 에 둔다 (비밀값이 저장소에 섞이지 않게, 데스크톱 앱도 이 자리를 본다).
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const target = resolve(here, "..", "smartstore_config.json");
if (existsSync(target)) {
  console.log(`설정 파일이 이미 있습니다: ${target}`);
} else {
  copyFileSync(resolve(here, "smartstore_config.example.json"), target);
  console.log(`설정 파일을 만들었습니다: ${target}`);
  console.log("discord_webhook_url · products · buy 칸을 채우고, 다음으로 .\\ss --login");
}
