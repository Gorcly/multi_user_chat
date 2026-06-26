CC = gcc
CFLAGS = -Wall -Wextra -g -Iinclude -pthread
LDFLAGS = -pthread -lcrypto

SERVER_TARGET = server_app
CLIENT_TARGET = client_app
UNIT_TARGET = test/unit_tests

COMMON_SRC = \
	common/protocol.c \
	common/net_utils.c \
	common/crypto_utils.c \
	common/user.c \
	common/message_queue.c \
	common/file_utils.c

SERVER_SRC = server/server.c $(COMMON_SRC)
CLIENT_SRC = client/client.c $(COMMON_SRC)
UNIT_SRC = test/unit_tests.c $(COMMON_SRC)

.PHONY: all clean test unit integration

all: $(SERVER_TARGET) $(CLIENT_TARGET)

$(SERVER_TARGET): $(SERVER_SRC)
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

$(CLIENT_TARGET): $(CLIENT_SRC)
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

$(UNIT_TARGET): $(UNIT_SRC)
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

unit: $(UNIT_TARGET)
	./$(UNIT_TARGET)

integration: all
	bash test/integration_test.sh

test: unit integration

clean:
	rm -f $(SERVER_TARGET) $(CLIENT_TARGET) $(UNIT_TARGET)
	rm -f test/*.o common/*.o server/*.o client/*.o
	rm -rf test/tmp downloads data
