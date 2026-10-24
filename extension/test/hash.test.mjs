// md5 / sm3 与 node:crypto 对照测试。
import crypto from "node:crypto";
import { md5Hex, md5Digest } from "../lib/md5.js";
import { sm3 } from "../lib/sm3.js";

let pass = 0;
let fail = 0;
function check(name, a, b) {
  if (a === b) pass += 1;
  else {
    fail += 1;
    console.error(`✗ ${name}: ${a} != ${b}`);
  }
}

// md5 已知值 + 随机对照
check("md5 empty", md5Hex(""), crypto.createHash("md5").update("").digest("hex"));
check("md5 rfc1321", md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
for (let i = 0; i < 30; i += 1) {
  const len = Math.floor(Math.random() * 500);
  const raw = crypto.randomBytes(len);
  check(
    `md5 random ${len}`,
    Buffer.from(md5Digest(raw)).toString("hex"),
    crypto.createHash("md5").update(raw).digest("hex")
  );
  check(
    `md5 hex-str ${len}`,
    md5Hex(raw),
    crypto.createHash("md5").update(raw).digest("hex")
  );
}

// sm3 已知值 + 随机对照
check("sm3 empty", Buffer.from(sm3(new TextEncoder().encode(""))).toString("hex"), crypto.createHash("sm3").update("").digest("hex"));
check("sm3 abc", Buffer.from(sm3(new TextEncoder().encode("abc"))).toString("hex"), crypto.createHash("sm3").update("abc").digest("hex"));
for (let i = 0; i < 20; i += 1) {
  const len = Math.floor(Math.random() * 500);
  const raw = crypto.randomBytes(len);
  check(
    `sm3 random ${len}`,
    Buffer.from(sm3(raw)).toString("hex"),
    crypto.createHash("sm3").update(raw).digest("hex")
  );
}

console.log(`\nmd5/sm3: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
