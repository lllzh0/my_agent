import { quote } from "shell-quote";

/** Quote literal argv for the selected product shell; also safe before SDK directory initialization. */
export function quoteCommand(argv: string[]): string {
	return process.platform === "win32"
		? `& ${argv.map(value => `'${value.replaceAll("'", "''")}'`).join(" ")}`
		: quote(argv);
}
