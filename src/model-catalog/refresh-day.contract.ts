/** JST calendar ownership eligibility. */
export default {post(result:string | null,now:number):boolean {
  const day=new Date(now+9*3_600_000); return day.getUTCHours()<10 ? result === null : result === day.toISOString().slice(0,10);
}};
