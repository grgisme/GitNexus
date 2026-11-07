/**
 * Regression (#11810): populateCsharpNamespaceSiblings pushed onto binding
 * arrays that finalize had frozen: "Cannot add property 1, object is not
 * extensible" in the scopeResolution phase on repos with C# namespaces.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C# namespace siblings with frozen binding arrays', () => {
  it('pipeline completes for several files sharing one namespace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cs-'));
    try {
      const files: Record<string, string> = {};
      for (const n of ['A', 'B', 'C', 'D']) {
        files[`${n}.cs`] =
          `using System;\nusing static System.Math;\nnamespace App.Core {\n  public class ${n} {\n    public void Run() { new ${n === 'A' ? 'B' : 'A'}().Run(); }\n  }\n  public class ${n}2 { }\n}\n`;
      }
      files['Util.cs'] =
        'namespace App.Core {\n  public static class Util { public static int F() { return 1; } }\n}\n';
      files['Main.cs'] =
        'using App.Core;\nusing static App.Core.Util;\nnamespace App.Other {\n  public class M { public int G() { return F() + new A().GetHashCode(); } }\n}\n';
      // Same simple name declared in two files of one namespace, consumed
      // by a third file that imports the namespace.
      files['Dup1.cs'] = 'namespace App.Core {\n  public partial class Dup { public void X() {} }\n}\n';
      files['Dup2.cs'] = 'namespace App.Core {\n  public partial class Dup { public void Y() {} }\n}\n';
      files['Use.cs'] =
        'using App.Core;\nnamespace App.Other {\n  public class U { public void Z() { new Dup().X(); } }\n}\n';
      for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
      const result = await runPipelineFromRepo(dir, () => {}, {});
      expect(result).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
