import { parseArgs } from "./args.js";
import { eprintln, formatError, println } from "./output.js";
import { init } from "./commands/init.js";
import { validate, lockBuild } from "./commands/validate.js";
import { configExplain, lockApprove, lockStatus } from "./commands/config.js";
import { doctor } from "./commands/doctor.js";
import { toolsAdd, toolsDescribe, toolsExport, toolsImport, toolsList } from "./commands/tools.js";
import { run } from "./commands/run.js";
import { approvalsDecide, approvalsList, contextExplain, inputsAnswer, memoryForget, memoryList } from "./commands/misc.js";
import { evalCommand } from "./commands/eval.js";

const USAGE = `sfield — Singularity Field CLI

  sfield init <name> --preset local            generated project (§4.6)
  sfield init <name> --template business-agent L2 starter with an HTTP integration (§24)
  sfield validate [--require-approved] [--json]
  sfield config explain [--agent ID] [--json]
  sfield lock build [--out sfield.lock.json]
  sfield lock approve <digest> [--eval-report ID] [--approver NAME] [--no-baseline]
  sfield lock status
  sfield doctor [--json]
  sfield tools list | describe <ref> | add [--manifest file] | import --source openapi --file spec | export [--out catalog.json]
  sfield run --agent ID --message "..." [--conversation ID] [--json]
  sfield run inspect RUN_ID [--json]
  sfield run resume RUN_ID
  sfield context explain CONTEXT_ID [--json]
  sfield memory list [--subject ID] [--kind preference|fact] [--all]
  sfield memory forget MEMORY_ID
  sfield approvals list [--all] | decide ID --approve|--deny [--comment TEXT] [--resume]
  sfield inputs answer REQUEST_ID --value <json>
  sfield eval --suite <dir> [--candidate <digest>] [--live] [--baseline REPORT_ID]

Common flags: --config sfield.yaml  --wiring harness.ts  --preset local|memory
`;

async function dispatch(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, sub] = args.positionals;
  switch (cmd) {
    case "init":
      return init(args);
    case "validate":
      return validate(args);
    case "config":
      if (sub === "explain") return configExplain(args);
      break;
    case "lock":
      if (sub === "build") return lockBuild(args);
      if (sub === "approve") return lockApprove(args);
      if (sub === "status") return lockStatus(args);
      break;
    case "doctor":
      return doctor(args);
    case "tools":
      if (sub === "list") return toolsList(args);
      if (sub === "describe") return toolsDescribe(args);
      if (sub === "add") return toolsAdd(args);
      if (sub === "import") return toolsImport(args);
      if (sub === "export") return toolsExport(args);
      break;
    case "run":
      return run(args);
    case "context":
      if (sub === "explain") return contextExplain(args);
      break;
    case "memory":
      if (sub === "list") return memoryList(args);
      if (sub === "forget") return memoryForget(args);
      break;
    case "approvals":
      if (sub === "list") return approvalsList(args);
      if (sub === "decide") return approvalsDecide(args);
      break;
    case "inputs":
      if (sub === "answer") return inputsAnswer(args);
      break;
    case "eval":
      return evalCommand(args);
    case undefined:
    case "help":
    case "--help":
      println(USAGE);
      return 0;
    default:
      break;
  }
  println(USAGE);
  return 2;
}

dispatch(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    eprintln(`error: ${formatError(e)}`);
    process.exit(1);
  },
);
