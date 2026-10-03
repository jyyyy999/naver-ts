// Stealth 의 evasion 하나하나는 타입을 달고 오지 않는다. launch.ts 가 쓰는 둘만 적어 둔다.

declare module "puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js" {
  /** locale 은 Accept-Language 와 (창이 있으면) 크롬의 언어 설정에 들어간다. 기본 "en-US,en". */
  const make: (opts?: { userAgent?: string; locale?: string; maskLinux?: boolean }) => import("puppeteer-extra").PuppeteerExtraPlugin;
  export default make;
}

declare module "puppeteer-extra-plugin-stealth/evasions/navigator.languages/index.js" {
  /** navigator.languages 가 돌려줄 것. 기본 ["en-US", "en"]. */
  const make: (opts?: { languages?: string[] }) => import("puppeteer-extra").PuppeteerExtraPlugin;
  export default make;
}
