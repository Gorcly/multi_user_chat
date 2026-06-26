#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>
#include <stddef.h>

#define USERNAME_MAX_LEN 32
#define PASSWORD_MAX_LEN 64
#define FILE_NAME_MAX_LEN 256
#define PACKET_DATA_MAX 1024
#define FILE_TRANSFER_MAX_BYTES (10 * 1024 * 1024)

typedef enum MessageType {
    MSG_REGISTER = 1,
    MSG_LOGIN = 2,
    MSG_PRIVATE = 3,
    MSG_GROUP = 4,
    MSG_ONLINE_LIST = 5,
    MSG_FILE_BEGIN = 6,
    MSG_FILE_CHUNK = 7,
    MSG_FILE_END = 8,
    MSG_LOGOUT = 9,
    MSG_HEARTBEAT = 10,
    MSG_BROADCAST = 11,
    MSG_OK = 12,
    MSG_ERROR = 13
} MessageType;

typedef struct Packet {
    int32_t type;
    uint32_t length;
    char sender[USERNAME_MAX_LEN];
    char receiver[USERNAME_MAX_LEN];
    unsigned char data[PACKET_DATA_MAX];
} Packet;

typedef struct FileBeginPayload {
    char filename[FILE_NAME_MAX_LEN];
    uint64_t filesize;
} FileBeginPayload;

int packet_init(Packet *packet, int type, const char *sender,
                const char *receiver, const void *data, size_t length);
int packet_set_text(Packet *packet, int type, const char *sender,
                    const char *receiver, const char *text);
int send_packet(int fd, const Packet *packet);
int recv_packet(int fd, Packet *packet);
const char *message_type_name(int type);

#endif
