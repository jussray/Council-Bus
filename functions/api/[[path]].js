import {createFounderApi} from '../../app/app-api.mjs';
const handle=createFounderApi();
export async function onRequest({request,env}) {return handle(request,env)}
