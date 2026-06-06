#!/usr/bin/env node
import { APP_NAME } from "./core/config.ts";
import { main } from "./main.ts";

process.title = APP_NAME;

main(process.argv.slice(2));
