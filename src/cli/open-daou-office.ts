// 다우오피스 전용 브라우저를 열어 최초 로그인에 사용한다.
import { getConfig } from "../config.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";

const config = getConfig();
const browser = new DaouOfficeBrowserController(config.daouOffice);
const result = await browser.openLoginWindow();
process.stdout.write(
  `${result.alreadyRunning ? "Existing" : "New"} DaouOffice browser is ready: ${result.url}\n`,
);
