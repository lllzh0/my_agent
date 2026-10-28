import { extractLiteralAndChainSegments } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";
import type { Request } from "./policy";

/** A floor, never a list of command names that proves a shell safe. */
export function highRiskReason(request: Request): string | undefined {
	const value = JSON.stringify(request);
	if (
		/\b(?:Remove-Item|Clear-Content|del|erase|rd|Set-Acl|icacls|takeown|reg(?:\.exe)?|New-Service|Set-Service|Stop-Service|schtasks|diskpart|Format-Volume|Clear-Disk)\b/i.test(
			request.target,
		)
	)
		return "Windows 操作可能删除数据、改变权限或修改持久系统设置";
	if (String(request.parameters?.gitWrite ?? "") === "true")
		return "命令申请写入 Git 元数据，可能触发 hooks 或改变历史";
	if (/(?:--force(?:-with-lease)?|--hard|--mirror|--delete|--prune(?:=|\s)|filter-branch|filter-repo)\b/.test(value))
		return "操作可能删除数据或重写 Git 历史";
	if (
		/(?:^|[\s;|&])(?:sudo|su|rm|rmdir|shred|mkfs|diskutil|launchctl|crontab|chmod|chown)(?:[\s;|&]|$)/.test(
			request.target,
		)
	)
		return "操作可能删除数据、改变权限或持久系统设置";
	if (
		/\b(?:git\s+(?:push|clean)|npm\s+publish|bun\s+publish|docker\s+push|terraform\s+apply|kubectl\s+(?:apply|delete))\b/.test(
			request.target,
		)
	)
		return "操作可能发布内容、影响远端或删除数据";
	if (
		/(?:\.ssh|\.aws|\.gnupg|\.env(?:\b|\.)|env\.local|auth\.json|id_(?:rsa|ed25519)|\b(?:password|api[_-]?key|access[_-]?token)\b)/i.test(
			value,
		)
	)
		return "操作涉及凭据或可能向外发送敏感信息";
	return;
}

export function looksLikeGitWrite(command: string): boolean {
	if (process.platform === "win32" && /[`$@(){}\r\n]/.test(command)) return false;
	const segments = extractLiteralAndChainSegments(command, { allowSingle: true });
	return segments !== null && segments.length === 1 && segments[0]!.argv[0] === "git" && segments[0]!.argv.length > 1;
}
