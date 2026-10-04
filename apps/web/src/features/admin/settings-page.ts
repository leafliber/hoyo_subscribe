// 管理端「运行开关」页：登录态由 session.ts 管理；开关面板（controls.ts）在工作区出现后自行读取。
import { request } from "./api";
import { startAdminSession } from "./session";

const session = startAdminSession({
  async load() {
    // 以管理接口是否 401 判断登录；面板随后自己读取并渲染开关。
    await request("admin/controls");
    session.showLoggedIn();
  },
  reset() {},
});
