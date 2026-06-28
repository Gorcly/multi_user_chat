#include "protocol.h"

#include "net_utils.h"

#include <arpa/inet.h>
#include <string.h>

typedef struct WireHeader {
    int32_t type;
    uint32_t length;
    char sender[USERNAME_MAX_LEN];
    char receiver[USERNAME_MAX_LEN];
} WireHeader;

static void copy_fixed_string(char *dest, size_t dest_size, const char *src) {
    if (dest_size == 0) {
        return;
    }
    memset(dest, 0, dest_size);
    if (src != NULL) {
        strncpy(dest, src, dest_size - 1);
    }
}

int packet_init(Packet *packet, int type, const char *sender,
                const char *receiver, const void *data, size_t length) {
    if (packet == NULL || length > PACKET_DATA_MAX) {
        return -1;
    }

    memset(packet, 0, sizeof(*packet));
    packet->type = type;
    packet->length = (uint32_t)length;
    copy_fixed_string(packet->sender, sizeof(packet->sender), sender);
    copy_fixed_string(packet->receiver, sizeof(packet->receiver), receiver);
    if (data != NULL && length > 0) {
        memcpy(packet->data, data, length);
    }
    return 0;
}

int packet_set_text(Packet *packet, int type, const char *sender,
                    const char *receiver, const char *text) {
    size_t len = 0;

    if (text != NULL) {
        len = strlen(text) + 1;
    }
    if (len > PACKET_DATA_MAX) {
        return -1;
    }
    return packet_init(packet, type, sender, receiver, text, len);
}

int send_packet(int fd, const Packet *packet) {
    WireHeader header;

    if (packet == NULL || packet->length > PACKET_DATA_MAX) {
        return -1;
    }

    memset(&header, 0, sizeof(header));
    header.type = htonl(packet->type);
    header.length = htonl(packet->length);
    memcpy(header.sender, packet->sender, sizeof(header.sender));
    memcpy(header.receiver, packet->receiver, sizeof(header.receiver));

    if (send_all(fd, &header, sizeof(header)) < 0) {
        return -1;
    }
    if (packet->length > 0 &&
        send_all(fd, packet->data, packet->length) < 0) {
        return -1;
    }
    return 0;
}

int recv_packet(int fd, Packet *packet) {
    WireHeader header;

    if (packet == NULL) {
        return -1;
    }

    memset(packet, 0, sizeof(*packet));
    if (recv_all(fd, &header, sizeof(header)) < 0) {
        return -1;
    }

    packet->type = ntohl(header.type);
    packet->length = ntohl(header.length);
    if (packet->length > PACKET_DATA_MAX) {
        return -1;
    }
    memcpy(packet->sender, header.sender, sizeof(packet->sender));
    memcpy(packet->receiver, header.receiver, sizeof(packet->receiver));
    packet->sender[USERNAME_MAX_LEN - 1] = '\0';
    packet->receiver[USERNAME_MAX_LEN - 1] = '\0';

    if (packet->length > 0 &&
        recv_all(fd, packet->data, packet->length) < 0) {
        return -1;
    }
    return 0;
}

const char *message_type_name(int type) {
    switch (type) {
    case MSG_REGISTER:
        return "REGISTER";
    case MSG_LOGIN:
        return "LOGIN";
    case MSG_PRIVATE:
        return "PRIVATE";
    case MSG_GROUP:
        return "GROUP";
    case MSG_ONLINE_LIST:
        return "ONLINE_LIST";
    case MSG_FILE_BEGIN:
        return "FILE_BEGIN";
    case MSG_FILE_CHUNK:
        return "FILE_CHUNK";
    case MSG_FILE_END:
        return "FILE_END";
    case MSG_LOGOUT:
        return "LOGOUT";
    case MSG_HEARTBEAT:
        return "HEARTBEAT";
    case MSG_BROADCAST:
        return "BROADCAST";
    case MSG_OK:
        return "OK";
    case MSG_ERROR:
        return "ERROR";
    case MSG_GROUP_CREATE:
        return "GROUP_CREATE";
    case MSG_GROUP_LIST:
        return "GROUP_LIST";
    case MSG_GROUP_MESSAGE:
        return "GROUP_MESSAGE";
    case MSG_GROUP_EVENT:
        return "GROUP_EVENT";
    default:
        return "UNKNOWN";
    }
}
