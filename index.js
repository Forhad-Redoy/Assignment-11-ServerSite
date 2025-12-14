require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_KEY);
const port = process.env.PORT || 3000;
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
//   'utf-8'
// )
// const serviceAccount = JSON.parse(decoded)
const serviceAccount = require("./a11-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_URL, process.env.CLIENT_URL2],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("mealsDB");
    const mealsCollection = db.collection("meals");
    const orderCollection = db.collection("orders");

    // Save all meals in db
    app.post("/meals", async (req, res) => {
      const meal = req.body;
      const result = await mealsCollection.insertOne(meal);
      res.send(result);
    });

    // get all meals from db
    app.get("/meals", async (req, res) => {
      const result = await mealsCollection.find().toArray();
      res.send(result);
    });

    // get all meals from db
    app.get("/meals/:id", async (req, res) => {
      const id = req.params.id;
      const result = await mealsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // save order in db
    app.post("/orders", async (req, res) => {
      const order = req.body;
      const result = await orderCollection.insertOne(order);
      res.send(result);
    });
    // get order from db
    app.get("/my-orders/user/:email", async (req, res) => {
      const email = req.params.email;

      const result = await orderCollection.find({ userEmail: email }).toArray();

      res.send(result);
    });

    // payment endpoint
    app.post("/create-checkout-session", async (req, res) => {
      const { orderId } = req.body;

      const order = await orderCollection.findOne({
        _id: new ObjectId(orderId),
      });

      if (!order) return res.status(404).send({ message: "Order not found" });

      const totalAmount = order.price * order.quantity;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: order.mealName,
              },
              unit_amount: totalAmount * 100,
            },
            quantity: 1,
          },
        ],
        metadata: {
          orderId: order._id.toString(),
          userEmail: order.userEmail,
        },
        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/my-orders`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log("Retrieved Session:", session);

      if (session.payment_status === "paid") {
        const orderId = session.metadata.orderId;

        //  Update order: paymentStatus → "paid"
        const updateOrder = await orderCollection.updateOne(
          { _id: new ObjectId(orderId) },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
            },
          }
        );

        // Save payment history
        const paymentInfo = {
          orderId,
          userEmail: session.metadata.userEmail,
          amount: session.amount_total / 100,
          currency: session.currency,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          sessionId: session.id,
          paidAt: new Date(),
        };

        const resultPayment = await paymentCollection.insertOne(paymentInfo);

        // Send success response to frontend
        return res.send({
          success: true,
          message: "Payment completed and order updated.",
          orderUpdate: updateOrder,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });
      }

      res.send({ success: false, message: "Payment not completed." });
    });

    // get meals by chef email
    app.get("/meals/chef/:email", async (req, res) => {
      const email = req.params.email;
      const result = await mealsCollection.find({ userEmail: email }).toArray();
      res.send(result);
    });

    // delete meal create by chef
    app.delete("/meals/:id", async (req, res) => {
      const id = req.params.id;
      const result = await mealsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // update meal
    // app.patch("/meals/:id", async (req, res) => {
    //   const id = req.params.id;
    //   const updatedMeal = req.body;

    //   const result = await mealsCollection.updateOne(
    //     { _id: new ObjectId(id) },
    //     { $set: updatedMeal }
    //   );

    //   res.send(result);
    // });
    app.patch("/meals/:id", async (req, res) => {
      const id = req.params.id;
      const updated = req.body;

      const updateDoc = {
        $set: {
          foodName: updated.foodName,
          chefName: updated.chefName,
          foodImage: updated.foodImage,
          price: updated.price,
          ingredients: updated.ingredients,
          estimatedDeliveryTime: updated.estimatedDeliveryTime,
          deliveryArea: updated.deliveryArea,
          chefExperience: updated.chefExperience,
          chefId: updated.chefId,
          updatedAt: new Date(),
        },
      };

      const result = await mealsCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc
      );

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
