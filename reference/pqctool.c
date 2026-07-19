/* Qbit PQC helper: SLH-DSA keygen-from-random-data and sign. Links vendored libbitcoinpqc. */
#include <stdio.h>
#include <string.h>
#include <libbitcoinpqc/slh_dsa.h>
int slh_dsa_keygen(unsigned char* pk, unsigned char* sk, const unsigned char* random_data, size_t n);
static int hx(const char*h,unsigned char*o,size_t n){for(size_t i=0;i<n;i++){unsigned v;if(sscanf(h+2*i,"%2x",&v)!=1)return -1;o[i]=(unsigned char)v;}return 0;}
static void px(const unsigned char*b,size_t n){for(size_t i=0;i<n;i++)printf("%02x",b[i]);printf("\n");}
int main(int argc,char**argv){
  if(argc<2){fprintf(stderr,"usage: pqctool keygen <randomdata128hex> | sign <sk64hex> <msg32hex>\n");return 2;}
  if(!strcmp(argv[1],"keygen")){
    unsigned char rd[128],pk[32],sk[64];
    if(hx(argv[2],rd,128)){fprintf(stderr,"bad hex\n");return 2;}
    if(slh_dsa_keygen(pk,sk,rd,128)!=0){fprintf(stderr,"keygen failed\n");return 1;}
    printf("pk ");px(pk,32);printf("sk ");px(sk,64);return 0;
  }
  if(!strcmp(argv[1],"sign")){
    unsigned char sk[SLH_DSA_SECRET_KEY_SIZE],msg[32],sig[SLH_DSA_SIGNATURE_SIZE];size_t sl=sizeof sig;
    if(hx(argv[2],sk,sizeof sk)||hx(argv[3],msg,32)){fprintf(stderr,"bad hex\n");return 2;}
    if(slh_dsa_sign(sig,&sl,msg,32,sk)!=0){fprintf(stderr,"sign failed\n");return 1;}
    px(sig,sl);return 0;
  }
  fprintf(stderr,"unknown mode\n");return 2;
}
