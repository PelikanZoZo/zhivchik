// Отпечаток пароля для входа на сайт.
// Запуск: node tools/hash-password.js 'новый пароль'
// Результат положи в переменную окружения AUTH_HASH в панели хостинга.
import crypto from "node:crypto";

const password = process.argv[2];
if (!password) { console.error("Укажи пароль: node tools/hash-password.js 'пароль'"); process.exit(1); }
const N = 32768, salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
console.log(`scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`);
