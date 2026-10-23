// Imported first by main.ts so git is hardened before @gitgoblin/intel copies process.env.
import { hardenGitEnvironment } from "./safety.ts";

hardenGitEnvironment(process.env);
