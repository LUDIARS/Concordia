/** Bootstrap pointer only; fresh capability validation is a separate boundary. */
export default {post(result:string,role:string):boolean {return role !== "sol" || result === "gpt-6.1-sol";}};
