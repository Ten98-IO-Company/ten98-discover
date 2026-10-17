import test from 'node:test';
import assert from 'node:assert/strict';
import {contentSupportQueryId} from '../src/server/ai-content-support-input.ts';
import {contentSupportQuoteInputSchema,contentSupportQuoteDtoSchema} from '../src/lib/ai-content-support.ts';
import {supportQueryId,readSupportQuote,readSupportRun,readSupportList,supportReceipt,sameSupportReceipt,quoteCurrent} from '../src/components/ai-content-support-ui.ts';
// Four exact DTOs captured by the passed native lifecycle run7f4126a1e75d.
// Source whole-artifact SHA256 ba7d0a5643318674ef2d45b124a6f33b9428a6535c1868dcd1ddb0fc89da64d7. No live provider calls.
const golden = {
  "quote": {
    "version": "ai-content-support-quote-v1",
    "role": "owner",
    "projectId": "2bb2b5c6-9737-432e-ba26-062e62b14ece",
    "quote": {
      "purpose": "website-content-support",
      "promptVersion": "closed-corpus-support-v1",
      "schemaVersion": 1,
      "method": "closed-corpus-model-judgment-v1",
      "derivationVersion": "immutable-prompt-trim-lower-v1",
      "id": "8890d806-dd79-4cc2-ba11-e32fc329c854",
      "requestId": "070ddaab-11df-4f71-bec2-c848d850000c",
      "createdAt": "2026-10-15T19:22:22.988388Z",
      "expiresAt": "2026-10-15T19:27:22.988388Z",
      "inputHash": "2f53965fe356b987c8f11d28189ee7dc091fdadd4dc6e06b68fc3d4fb62c02d7",
      "payloadHash": "f8c971584abf4c9444a1641761ea79218b5943fde56e798c4e8e0f293d9d97f6",
      "schemaHash": "d009e6e8bcc6ad8c035fe45d9da9a7dfdac82589ccf99ee155b61c4a1fbfc8b7",
      "queryReceiptHash": "b4740da8f403a034747f2da528ebf341113f24cbcca7e5580387c56852589ab0",
      "corpusReceiptHash": "2da034dbe63a8ed1eeb4291d5117d84000d24e711d8ab67fdcb64cd2485b3a6f",
      "route": {
        "model": "mistralai/mistral-small-3.2-24b-instruct",
        "tag": "compute/leaf-a",
        "providerName": "Synthetic Compute",
        "profile": "openrouter-api-text-no-search-v2",
        "contextLength": 128000,
        "promptCapacity": 128000,
        "completionCapacity": 16384,
        "promptPrice": "0.00000015",
        "completionPrice": "0.0000006",
        "requestPrice": "0",
        "estimateMicros": "20429"
      },
      "estimateUsd": "0.020429",
      "maxSpendUsd": "0.030000",
      "inputExpired": false,
      "input": {
        "requestId": "070ddaab-11df-4f71-bec2-c848d850000c",
        "connectionId": "cbd666a1-81b0-4ad7-a20c-6f6f28c89176",
        "model": "mistralai/mistral-small-3.2-24b-instruct",
        "fundedCredits": true,
        "evaluation": true,
        "maxSpendUsd": "0.030000",
        "source": {
          "kind": "capture",
          "selection": {
            "captureId": "2ba22c60-e664-4581-82a0-33d68c089d05",
            "auditRunId": "6590f7c9-6c7f-4ee3-8926-7094d496da11",
            "pages": {
              "coverage": null,
              "resourceKind": "html",
              "search": "",
              "searchIn": "url",
              "sort": "url",
              "order": "asc",
              "expectedSelectionRevision": "bbbdc82664afc6b248287d4c9daaf8a289ad7b4c1df72477ec191464e979ae82"
            }
          }
        },
        "expectedQueryReceiptHash": "b4740da8f403a034747f2da528ebf341113f24cbcca7e5580387c56852589ab0",
        "expectedCorpusReceiptHash": "2da034dbe63a8ed1eeb4291d5117d84000d24e711d8ab67fdcb64cd2485b3a6f",
        "selectedQueryIds": [
          "701acca28bd49bd7a1d0f8c85701a89e580e8928afc8df377d278b831272c056"
        ],
        "selectedPageIds": [
          "3be57ca6-cef8-4d37-b17e-4975fc6239b2"
        ]
      },
      "selection": {
        "queries": [
          {
            "id": "701acca28bd49bd7a1d0f8c85701a89e580e8928afc8df377d278b831272c056",
            "key": "query 29"
          }
        ],
        "pages": [
          {
            "id": "3be57ca6-cef8-4d37-b17e-4975fc6239b2",
            "auditRunId": "6590f7c9-6c7f-4ee3-8926-7094d496da11",
            "url": "https://2bb2b5c6-9737-432e-ba26-062e62b14ece.content-support.test/0",
            "bodySha256": "f25d1852e5d0c5c6b61addb0be1458cb34ecec1cceaf87e45045f2713fc3ff23",
            "bodyLength": 62,
            "observedAt": "2026-10-13T19:22:22.388000Z",
            "extractionVersion": "static-dom-body-v1"
          }
        ],
        "exclusions": {
          "queries": 29,
          "pages": 1
        }
      }
    },
    "replayed": false
  },
  "completed": {
    "version": "ai-content-support-run-v1",
    "role": "owner",
    "projectId": "2bb2b5c6-9737-432e-ba26-062e62b14ece",
    "run": {
      "purpose": "website-content-support",
      "promptVersion": "closed-corpus-support-v1",
      "schemaVersion": 1,
      "method": "closed-corpus-model-judgment-v1",
      "derivationVersion": "immutable-prompt-trim-lower-v1",
      "id": "0e822e42-1833-4c26-afd5-9d9ee1e034bd",
      "quoteId": "8890d806-dd79-4cc2-ba11-e32fc329c854",
      "requestId": "f0db4e7a-8fc3-4bcb-a59e-fc43abcdf601",
      "inputHash": "2f53965fe356b987c8f11d28189ee7dc091fdadd4dc6e06b68fc3d4fb62c02d7",
      "payloadHash": "f8c971584abf4c9444a1641761ea79218b5943fde56e798c4e8e0f293d9d97f6",
      "queryReceiptHash": "b4740da8f403a034747f2da528ebf341113f24cbcca7e5580387c56852589ab0",
      "corpusReceiptHash": "2da034dbe63a8ed1eeb4291d5117d84000d24e711d8ab67fdcb64cd2485b3a6f",
      "resultHash": "bb67bc9715f63bb3d9476af4aab29fd48e337c39363f1a1f2e327a59d5342c39",
      "route": {
        "model": "mistralai/mistral-small-3.2-24b-instruct",
        "tag": "compute/leaf-a",
        "providerName": "Synthetic Compute",
        "profile": "openrouter-api-text-no-search-v2",
        "contextLength": 128000,
        "promptCapacity": 128000,
        "completionCapacity": 16384,
        "promptPrice": "0.00000015",
        "completionPrice": "0.0000006",
        "requestPrice": "0",
        "estimateMicros": "20429"
      },
      "status": "completed",
      "chargeStatus": "settled",
      "estimateUsd": "0.020429",
      "actualUsd": "0.000013",
      "createdAt": "2026-10-15T19:22:23.194238Z",
      "dispatchedAt": "2026-10-15T19:22:23.368447Z",
      "completedAt": "2026-10-15T19:22:23.416738Z",
      "generationId": "gen-4ff65c9b-06a2-458a-b0dc-850d5f764f5e",
      "diagnostic": null,
      "inputExpired": false,
      "resultExpired": false,
      "selection": {
        "queries": [
          {
            "id": "701acca28bd49bd7a1d0f8c85701a89e580e8928afc8df377d278b831272c056",
            "key": "query 29"
          }
        ],
        "pages": [
          {
            "id": "3be57ca6-cef8-4d37-b17e-4975fc6239b2",
            "auditRunId": "6590f7c9-6c7f-4ee3-8926-7094d496da11",
            "url": "https://2bb2b5c6-9737-432e-ba26-062e62b14ece.content-support.test/0",
            "bodySha256": "f25d1852e5d0c5c6b61addb0be1458cb34ecec1cceaf87e45045f2713fc3ff23",
            "bodyLength": 62,
            "observedAt": "2026-10-13T19:22:22.388000Z",
            "extractionVersion": "static-dom-body-v1"
          }
        ],
        "exclusions": {
          "queries": 29,
          "pages": 1
        }
      },
      "proposal": {
        "version": 1,
        "rows": [
          {
            "queryId": "701acca28bd49bd7a1d0f8c85701a89e580e8928afc8df377d278b831272c056",
            "state": "supported",
            "rationale": "=SUM(1,1)",
            "citations": [
              {
                "pageId": "3be57ca6-cef8-4d37-b17e-4975fc6239b2",
                "bodySha256": "f25d1852e5d0c5c6b61addb0be1458cb34ecec1cceaf87e45045f2713fc3ff23",
                "start": 0,
                "end": 5,
                "quote": "Solar"
              }
            ]
          }
        ],
        "semanticConclusions": "unverified",
        "evidenceValidation": "exact-supplied-spans-v1"
      },
      "canCancel": false,
      "canReconcile": false
    }
  },
  "uncertain": {
    "version": "ai-content-support-run-v1",
    "role": "owner",
    "projectId": "9af2ddb5-8750-43c4-bb30-6f3e7f20e821",
    "run": {
      "purpose": "website-content-support",
      "promptVersion": "closed-corpus-support-v1",
      "schemaVersion": 1,
      "method": "closed-corpus-model-judgment-v1",
      "derivationVersion": "immutable-prompt-trim-lower-v1",
      "id": "7b879870-b008-4049-9856-90e933121c5e",
      "quoteId": "521541df-a362-4909-90bd-d5f3fbe9bc82",
      "requestId": "c0fd60b4-d933-4450-94fe-b3d488be37e5",
      "inputHash": "b0e656f7d53bac2e0c95bb23b07125d36296a2ce7cbb38a013c4eb62101c35fc",
      "payloadHash": "e069fa1eb1b16a3c77234906a9c269f65e1716ab79fa6eebf71e1eda13b3677a",
      "queryReceiptHash": "b193fe72f6184aaacea90223e7c7cd2f78d1dc818ac94449b61e9d29cb2c4832",
      "corpusReceiptHash": "e6855b420f84143e744a57d02149e98beb172dfc6718e7f9a6a3b8ac967fff06",
      "resultHash": null,
      "route": {
        "model": "mistralai/mistral-small-3.2-24b-instruct",
        "tag": "compute/leaf-a",
        "providerName": "Synthetic Compute",
        "profile": "openrouter-api-text-no-search-v2",
        "contextLength": 128000,
        "promptCapacity": 128000,
        "completionCapacity": 16384,
        "promptPrice": "0.00000015",
        "completionPrice": "0.0000006",
        "requestPrice": "0",
        "estimateMicros": "20429"
      },
      "status": "uncertain",
      "chargeStatus": "uncertain",
      "estimateUsd": "0.020429",
      "actualUsd": null,
      "createdAt": "2026-10-15T19:22:26.743230Z",
      "dispatchedAt": "2026-10-15T19:22:26.856248Z",
      "completedAt": "2026-10-15T19:22:26.900079Z",
      "generationId": "gen-cb3fc2fb-922f-4f7b-99b5-d4779fbfa4ab",
      "diagnostic": "The provider charge is unresolved. Reconcile this request before spending again.",
      "inputExpired": false,
      "resultExpired": false,
      "selection": {
        "queries": [
          {
            "id": "701acca28bd49bd7a1d0f8c85701a89e580e8928afc8df377d278b831272c056",
            "key": "query 29"
          }
        ],
        "pages": [
          {
            "id": "867a1c47-7dc9-4e28-96df-e27324894b15",
            "auditRunId": "8a3ed626-c815-4f0d-95f0-daba1624f8bb",
            "url": "https://9af2ddb5-8750-43c4-bb30-6f3e7f20e821.content-support.test/0",
            "bodySha256": "f25d1852e5d0c5c6b61addb0be1458cb34ecec1cceaf87e45045f2713fc3ff23",
            "bodyLength": 62,
            "observedAt": "2026-10-13T19:22:26.590000Z",
            "extractionVersion": "static-dom-body-v1"
          }
        ],
        "exclusions": {
          "queries": 29,
          "pages": 1
        }
      },
      "proposal": null,
      "canCancel": false,
      "canReconcile": true
    }
  },
  "expired": {
    "version": "ai-content-support-run-v1",
    "role": "owner",
    "projectId": "672baf4f-454e-41e1-8d21-8217d824aad9",
    "run": {
      "purpose": "website-content-support",
      "promptVersion": "closed-corpus-support-v1",
      "schemaVersion": 1,
      "method": "closed-corpus-model-judgment-v1",
      "derivationVersion": "immutable-prompt-trim-lower-v1",
      "id": "e3b31d9e-6ef3-493b-b5c7-4466fa592524",
      "quoteId": "34e74a20-dbb2-4eaa-801b-cfb385732af6",
      "requestId": "92aafe57-68e7-4e2d-87c8-8716d4a2345d",
      "inputHash": "d4ee6519cfedc0405ff42a9551d112dee8edd82acdc550b8140f81e8f4294f5f",
      "payloadHash": "7bff1ffaed9350dddb55efcdf65dbf141b87c2c3da6f412d32ec7e68652aed11",
      "queryReceiptHash": "cea4c0824e9f4feedae3b4c652428baa91ee3b19d0f584790e4f252c3ac9494d",
      "corpusReceiptHash": "9fab742c50358444f0e17017eddc39e1d0b043ca6d46312798304325717600f1",
      "resultHash": null,
      "route": {
        "model": "mistralai/mistral-small-3.2-24b-instruct",
        "tag": "compute/leaf-a",
        "providerName": "Synthetic Compute",
        "profile": "openrouter-api-text-no-search-v2",
        "contextLength": 128000,
        "promptCapacity": 128000,
        "completionCapacity": 16384,
        "promptPrice": "0.00000015",
        "completionPrice": "0.0000006",
        "requestPrice": "0",
        "estimateMicros": "20429"
      },
      "status": "completed",
      "chargeStatus": "settled",
      "estimateUsd": "0.020429",
      "actualUsd": "0.000013",
      "createdAt": "2026-10-15T19:22:30.146633Z",
      "dispatchedAt": "2026-10-15T19:22:30.260736Z",
      "completedAt": "2026-10-15T19:22:30.304303Z",
      "generationId": "gen-602dbf7d-907d-43c0-a8e7-89b8231f76a5",
      "diagnostic": null,
      "inputExpired": true,
      "resultExpired": true,
      "selection": null,
      "proposal": null,
      "canCancel": false,
      "canReconcile": false
    }
  }
};

// The golden quote is the pre-D3 capture. Since owner decision D3 the server strips the recorded ceiling from the quote and its input.
const {maxSpendUsd:_ceiling,input:{maxSpendUsd:_inputCeiling,...currentInput},...currentQuote}=golden.quote.quote,current={...golden.quote,quote:{...currentQuote,input:currentInput}};
const q=contentSupportQuoteDtoSchema.parse((({replayed,...body})=>body)(current)),input=contentSupportQuoteInputSchema.parse(q.quote.input),queryKeys=q.quote.selection!.queries.map(row=>row.key);
test('browser WebCrypto query IDs equal the native canonical identities, including exact Unicode forms',async()=>{
 for(const key of ['query 29','café','cafe\u0301','الطاقة الشمسية','solar 😀 batteries','a"b\\c'])assert.equal(await supportQueryId(key),contentSupportQueryId(key));
 assert.notEqual(await supportQueryId('café'),await supportQueryId('cafe\u0301'));
 for(const key of ['', ' Uppercase ', 'UPPER', 'x\0', '\ud800'])await assert.rejects(supportQueryId(key));
});
test('actual native quote and exact replay preserve source/model/query bindings with no ceiling (D3)',()=>{
 assert.equal(readSupportQuote(current,q.projectId,input,queryKeys).quote.id,q.quote.id);
 assert.equal(readSupportQuote({...current,replayed:true},q.projectId,input,queryKeys).replayed,true);
 assert.equal(Object.hasOwn(q.quote,'maxSpendUsd'),false);assert.equal(Object.hasOwn(input,'maxSpendUsd'),false);
 // A DTO or a sent quote body that still names a ceiling is refused, the exact pre-D3 capture included.
 for(const ceiling of [golden.quote,{...current,quote:{...current.quote,maxSpendUsd:'0.030000'}},{...current,quote:{...current.quote,input:{...current.quote.input,maxSpendUsd:'0.030000'}}}])assert.throws(()=>readSupportQuote(ceiling,q.projectId,input,queryKeys));
 assert.equal(contentSupportQuoteInputSchema.safeParse({...input,maxSpendUsd:'0.030000'}).success,false);
 assert.throws(()=>readSupportQuote(current,crypto.randomUUID(),input,queryKeys));
 for(const changed of [{...input,requestId:crypto.randomUUID()},{...input,connectionId:crypto.randomUUID()},{...input,model:'other/valid-model'},{...input,maxSpendUsd:'0.030000'},{...input,expectedQueryReceiptHash:'0'.repeat(64)},{...input,selectedPageIds:[crypto.randomUUID()]}])assert.throws(()=>readSupportQuote(current,q.projectId,changed,queryKeys));
 assert.throws(()=>readSupportQuote(current,q.projectId,input,['different query']));
 assert.throws(()=>readSupportQuote({...current,role:'viewer'},q.projectId,input,queryKeys));
 assert.throws(()=>readSupportQuote({...current,unexpected:true},q.projectId,input,queryKeys));
 assert.equal(quoteCurrent(q.quote,new Date(q.quote.createdAt)),true);assert.equal(quoteCurrent(q.quote,new Date(Date.parse(q.quote.expiresAt)+1)),false);assert.equal(quoteCurrent({...q.quote,inputExpired:true,input:null,selection:null},new Date(q.quote.createdAt)),false);
});
test('actual completed/uncertain/expired reads preserve unknown versus known cost and reject foreign or changed identities',()=>{
 const completed=readSupportRun(golden.completed,q.projectId,undefined,q.quote),run=completed.run;
 assert.equal(run.actualUsd,'0.000013');assert.equal(run.proposal!.semanticConclusions,'unverified');assert.equal(sameSupportReceipt(run,structuredClone(run)),true);
 assert.throws(()=>readSupportRun(golden.completed,crypto.randomUUID()));assert.throws(()=>readSupportRun(golden.completed,q.projectId,crypto.randomUUID()));
 assert.throws(()=>readSupportRun(golden.completed,q.projectId,run.id,{...q.quote,payloadHash:'0'.repeat(64)}));
 assert.equal(readSupportRun({...golden.completed,replayed:true},q.projectId,run.id,q.quote,true).replayed,true);
 assert.throws(()=>readSupportRun({...golden.completed,replayed:true},q.projectId));
 assert.throws(()=>readSupportRun({...golden.completed,run:{...run,actualUsd:null}},q.projectId));
 const lost=readSupportRun(golden.uncertain,golden.uncertain.projectId).run;assert.equal(lost.chargeStatus,'uncertain');assert.equal(lost.actualUsd,null);assert.equal(lost.proposal,null);
 const expired=readSupportRun(golden.expired,golden.expired.projectId).run;assert.equal(expired.inputExpired,true);assert.equal(expired.selection,null);assert.equal(expired.proposal,null);assert.equal(expired.resultHash,null);
 for(const field of ['payloadHash','resultHash','queryReceiptHash','corpusReceiptHash']as const)assert.equal(sameSupportReceipt(run,{...run,[field]:'0'.repeat(64)}),false);
 assert.equal(sameSupportReceipt(run,{...run,route:{...run.route,tag:'other/leaf'}}),false);assert.deepEqual(Object.keys(supportReceipt(run)),['expectedPayloadHash','expectedResultHash','expectedQueryReceiptHash','expectedCorpusReceiptHash']);
});
test('all-role list validation checks every actual run and current owner admission without promoting stale copies',()=>{
 for(const role of ['owner','admin','editor','viewer']as const){const value={version:'ai-content-support-list-v1',role,projectId:q.projectId,canQuote:role==='owner',admission:'owner-evaluation',semanticConclusions:'unverified',connections:[],runs:[golden.completed.run],nextCursor:null};assert.equal(readSupportList(value,q.projectId).role,role);assert.throws(()=>readSupportList({...value,canQuote:role!=='owner'},q.projectId));assert.throws(()=>readSupportList({...value,runs:[golden.completed.run,golden.completed.run]},q.projectId));assert.throws(()=>readSupportList(value,crypto.randomUUID()));}
});
