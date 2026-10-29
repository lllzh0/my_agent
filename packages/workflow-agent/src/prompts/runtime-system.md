{{base}}
{{#if skills.length}}
<temporarily_available_skills>
{{#each skills}}
<skill name="{{name}}" path="{{filePath}}">{{description}}</skill>
{{/each}}
</temporarily_available_skills>
These additional skills were approved for this Agent run or its current invocation. Use request_skill to load them; approval does not change tool, write, network or MCP permissions.
{{/if}}
