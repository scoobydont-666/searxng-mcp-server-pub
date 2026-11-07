import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResult } from '../load/validate-result.mjs';

test('HTTP 200 is not sufficient search evidence', () => {
  for (const payload of [{}, {query:'q',results:[]}, {query:'different',results:[{title:'x',url:'https://example.org'}]}]) {
    assert.equal(validateResult('api', 200, payload, 'q').valid, false);
  }
  assert.equal(validateResult('mcp', 200, {result:{isError:true}}, 'q').valid, false);
});

test('protocol results are inspected and partial engines are visible', () => {
  const payload = {query:'q', results:[{title:'x',url:'https://example.org'}], unresponsive_engines:[['one','timeout']]};
  assert.deepEqual(validateResult('api', 200, payload, 'q'), {valid:true,partial:true});
  assert.deepEqual(validateResult('mcp', 200, {result:{content:[{type:'text',text:JSON.stringify(payload)}]}}, 'q'), {valid:true,partial:true});
  assert.equal(validateResult('api', 503, payload, 'q').valid, false);
});
