#include <stdio.h>
#include <string.h>
#include <libbitcoinpqc/slh_dsa.h>
static int hx(const char*h,unsigned char*o,size_t n){for(size_t i=0;i<n;i++){unsigned v;if(sscanf(h+2*i,"%2x",&v)!=1)return -1;o[i]=(unsigned char)v;}return 0;}
int main(int argc,char**argv){
  if(argc<3){fprintf(stderr,"usage: pqcsign <sk64hex> <msg32hex>\n");return 2;}
  unsigned char sk[SLH_DSA_SECRET_KEY_SIZE],msg[32],sig[SLH_DSA_SIGNATURE_SIZE];
  if(hx(argv[1],sk,sizeof sk)||hx(argv[2],msg,32)){fprintf(stderr,"bad hex\n");return 2;}
  size_t sl=sizeof sig;
  if(slh_dsa_sign(sig,&sl,msg,32,sk)!=0){fprintf(stderr,"sign failed\n");return 1;}
  for(size_t i=0;i<sl;i++)printf("%02x",sig[i]);printf("\n");return 0;
}
