// Dispara um job e uma mensagem de chat do painel contra os comandos falsos do PATH: o que sai é o que o sistema receberia.
// Uso: bun lib/contrato-efemeros.ts <D>   (HADES_CHAT_BIN aponta para um executável qualquer)
import { createChat } from "../../../../src/panel/chat.ts";
import { panelEnv } from "../../../../src/panel/env.ts";
import { createJobs } from "../../../../src/panel/jobs.ts";

const env = panelEnv(process.argv[2]!);
const jobs = createJobs(env);
const id = await jobs.launch("teste", "Teste", "echo oi", false);
console.log(`job ${id.replace(/^\d{8}-\d{6}-[0-9a-f]{4}$/, "<id>")}`);
const chat = createChat({
  env, unit: `${env.hu}-chat`,
  config: () => ({ HADES_CHAT: "1", HADES_CHAT_BIN: process.env.HADES_CHAT_BIN ?? "", HADES_MODEL_CHAT: "modelo-x", HADES_EFFORT_CHAT: "alto" }),
});
const sid = await chat.send("", "olá", false);
console.log(`chat ${sid.replace(/^[0-9a-f]{8}$/, "<sid>")}`);
