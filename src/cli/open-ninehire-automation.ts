// 나인하이어 자동화 전용 Chrome 프로필을 열어 최초 로그인에 사용한다.
import { getConfig } from "../config.js";
import { NinehireBrowserController } from "../ninehire/browser.js";

const config = getConfig();
const browser = new NinehireBrowserController(config.ninehire);
const result = await browser.openLoginWindow();
process.stdout.write(
  `${result.alreadyRunning ? "Existing" : "New"} Ninehire browser is ready: ${result.url}\n`,
);
