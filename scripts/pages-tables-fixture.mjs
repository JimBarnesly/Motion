import { performance } from "node:perf_hooks";
import { WorkspaceDocument, createWorkspace } from "@motion/core";
import { SqliteWorkspaceStore } from "@motion/storage";

const STATUS = [{ id:"todo",name:"To do" },{ id:"progress",name:"In progress" },{ id:"done",name:"Done" }];
const PRIORITY = [{ id:"low",name:"Low" },{ id:"medium",name:"Medium" },{ id:"high",name:"High" }];

export function createPagesTablesFixture(recordCount=100) {
  const document=new WorkspaceDocument(createWorkspace(`Pages and tables (${recordCount})`));
  const house=document.addPage("House"),notes=document.addPage("Renovation Notes",house.id);
  const jobsPage=document.addPage("Jobs",house.id);
  const properties=[
    {id:"fixture-title",name:"Name",type:"title"},
    {id:"fixture-status",name:"Status",type:"status",options:STATUS},
    {id:"fixture-priority",name:"Priority",type:"select",options:PRIORITY},
    {id:"fixture-due",name:"Due",type:"date"},
    {id:"fixture-cost",name:"Cost",type:"number"},
    {id:"fixture-contractor",name:"Contractor",type:"text"},
    {id:"fixture-complete",name:"Complete",type:"checkbox"}
  ];
  const database=document.addDatabase({id:"fixture-jobs",pageId:jobsPage.id,name:"Jobs",properties,rows:[],recordPageIds:[],views:[{id:"fixture-table",collectionId:"fixture-jobs",name:"Table",type:"table",visiblePropertyIds:properties.map(property=>property.id),propertyOrder:properties.map(property=>property.id),columnWidths:{"fixture-title":320,"fixture-status":150,"fixture-priority":120,"fixture-due":140,"fixture-cost":110,"fixture-contractor":190,"fixture-complete":100},filters:{kind:"condition",propertyId:"fixture-complete",operator:"equals",value:false},sorts:[{propertyId:"fixture-priority",direction:"desc"},{propertyId:"fixture-due",direction:"asc"}]}]});
  for(let index=0;index<recordCount;index++){
    const record=document.addRecord(database.id,index===0?"Replace heat pump":`House job ${String(index+1).padStart(4,"0")}`,{
      "fixture-status":STATUS[index%STATUS.length].id,"fixture-priority":PRIORITY[index%PRIORITY.length].id,
      "fixture-due":`2026-${String((index%12)+1).padStart(2,"0")}-${String((index%27)+1).padStart(2,"0")}T00:00:00.000Z`,
      "fixture-cost":250+(index*37)%12000,"fixture-contractor":`Contractor ${index%18+1}`,"fixture-complete":index%5===0
    });
    document.addBlock(record.id,{type:"paragraph",text:index===0?"Need quotes from three suppliers.":`Notes for job ${index+1}.`});
  }
  const first=document.records(database.id)[0];
  document.addBlock(notes.id,{type:"paragraph",text:"Coordinate planning with [[Replace heat pump]].",references:[{pageId:first.id}]});
  document.rebuildLinkIndex();
  return document.data;
}

export function benchmarkPagesTables(recordCount) {
  const before=process.memoryUsage().heapUsed,start=performance.now(),workspace=createPagesTablesFixture(recordCount),created=performance.now();
  const openedDocument=new WorkspaceDocument(structuredClone(workspace)),opened=performance.now();
  const database=workspace.databases[0],view=database.views[0];
  const filtered=openedDocument.queryRecords(database.id,view.filters,[]),filterDone=performance.now();
  const sorted=openedDocument.queryRecords(database.id,undefined,view.sorts),sortDone=performance.now();
  const target=sorted[Math.floor(sorted.length/2)],editStart=performance.now();
  openedDocument.updateRecord(target.id,undefined,{"fixture-cost":9999});const editDone=performance.now();
  return {records:recordCount,fixtureMs:created-start,openMs:opened-created,filterMs:filterDone-opened,sortMs:sortDone-filterDone,editMs:editDone-editStart,filteredRecords:filtered.length,heapDeltaMiB:(process.memoryUsage().heapUsed-before)/1024/1024};
}

if(import.meta.url===`file://${process.argv[1]}`){
  const recordCount=Number(process.argv[2]??100),databasePath=process.argv[3];
  const workspace=createPagesTablesFixture(recordCount);
  if(databasePath){const store=new SqliteWorkspaceStore(databasePath);store.saveUnitOfWork({workspaceId:workspace.id,schemaVersion:workspace.schemaVersion,document:workspace,expectedRevision:0});store.close();}
  console.log(JSON.stringify(benchmarkPagesTables(recordCount),null,2));
}
