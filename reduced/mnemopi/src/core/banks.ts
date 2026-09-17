/** Reduced port of packages/mnemopi/src/core/banks.ts — bank directory management. */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir as configuredDataDir } from "../config";

const DB_FILENAME = "mnemopi.db";

export class BankManager {
	readonly dataDir: string;
	readonly banksDir: string;

	constructor(dataDir?: string) {
		this.dataDir = dataDir ?? configuredDataDir();
		this.banksDir = join(this.dataDir, "banks");
	}

	listBanks(): string[] {
		const banks: string[] = ["default"];
		if (existsSync(this.banksDir)) {
			for (const entry of readdirSync(this.banksDir, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name !== "default") banks.push(entry.name);
			}
		}
		return banks.sort();
	}

	getBankDbPath(name: string): string {
		if (name.length === 0 || name === "default") return join(this.dataDir, DB_FILENAME);
		return join(this.banksDir, name, DB_FILENAME);
	}
}
